/**
 * 权限变更即时生效测试（PRD v1.3 §5.5 C-5 / F-09）
 *
 * 核心命题：管理员撤销用户权限后，**该用户的下一次请求必须立即被拒**，
 * 不能因为权限快照缓存（TTL 300s）而留下最长 5 分钟的越权窗口。
 * 这是安全项而非体验项：撤权后仍能访问涉密档案 = 越权漏洞。
 *
 * ## 用例分类（PM 裁定，勿整体统一标注）
 *
 * **A 类·机制类**（`A:` 前缀）：测缓存**构造本身**（TTL / key 命名空间 /
 *   命中不查库 / 失效范围 / 降级回源）。单实例结论完整，多实例不影响其有效性，
 *   **不标**「多实例待补」。
 *
 * **B 类·生效类**（`B:` 前缀）：测「撤权后真的不能再访问」。单实例验证通过，
 *   多实例语义（版本号 INCR + pub/sub 广播）属**待补**项，需工程师 E 包实装后
 *   在同一进程起两个实例共享同一 FakeRedis 补测。
 *
 * **R 类·风险实证**（`R:` 前缀）：证明「不做主动失效会怎样」。
 *   C-5 裁定后，此类用例**证明的是风险存在，不是合规项**——
 *   不得与「已验证项」并列计入通过清单，否则读者会读出
 *   「300s 窗口是设计可接受的」。C-5 达标线是 invalidate 调用链 100% 覆盖。
 *
 * ## 两种漏法的区别（报告中分两栏，不可混为一谈）
 *  - 多实例漏 = 广播没发出去（版本号/广播通道失效）
 *  - 调用链漏 = invalidate 压根没被调用（PERMISSION_MUTATIONS 遗漏入口）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_KEY } from '@api/common/constants/enums';
import { UserService } from '@api/modules/user/user.service';
import { SecurityLevel, type PermissionSnapshot } from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
/**
 * FakeRedis：同时模拟「数据键」与「版本号计数键」两类命名空间。
 *
 * 关键点：计数键与数据键**分离存储**，因为 Redis 中 INCR 只能作用于字符串键，
 * 若混用同一 Map，setJson 的对象会与计数器互相覆盖，掩盖真实缺陷。
 */
class FakeRedis {
  /** 普通数据键（perm:{id}:v{n}、字典缓存等） */
  public store = new Map<string, unknown>();
  /** 计数器键（perm_ver:{id}），模拟 Redis 的 INCR 语义 */
  public counters = new Map<string, number>();
  /** pub/sub 广播记录（多实例失效通道），供 B 类用例断言 */
  public published: Array<{ channel: string; message: string }> = [];
  /** 已订阅的通道 → 回调（模拟第二个实例的订阅者） */
  public subscribers = new Map<string, Array<(channel: string, message: string) => void>>();

  public async getJson<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    return hit === undefined ? null : (hit as T);
  }

  public async setJson(key: string, value: unknown, _ttl?: number): Promise<void> {
    this.store.set(key, value);
  }

  public async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  /**
   * 前缀删除。真实 Redis 的 SCAN/DEL 不区分「数据键」与「计数键」——
   * 两者都在同一个 keyspace 里。因此这里是**唯一必须跨两个 Map 操作**的方法，
   * 否则全量失效清 account 计数键的行为会被夹具吞掉（假绿）。
   */
  public async delByPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        n += 1;
      }
    }
    for (const k of [...this.counters.keys()]) {
      if (k.startsWith(prefix)) {
        this.counters.delete(k);
        n += 1;
      }
    }
    return n;
  }

  public async incr(key: string): Promise<number> {
    const v = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, v);
    return v;
  }

  public async getCounter(key: string): Promise<number> {
    return this.counters.get(key) ?? 0;
  }

  public async expire(_key: string, _ttl: number): Promise<void> {
    // 单元测试不实现真实 TTL 过期（TTL 行为由 FakeTimers 场景覆盖）
  }

  public async publish(channel: string, message: string): Promise<void> {
    this.published.push({ channel, message });
    // 投递给本 FakeRedis 上的所有订阅者（可模拟「跨实例」）
    for (const cb of this.subscribers.get(channel) ?? []) cb(channel, message);
  }

  public async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : String(v);
  }

  public async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function snapOf(userId: string, over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    userId,
    username: userId,
    displayName: userId,
    roles: ['R-ARCHIVIST'],
    grants: {},
    maxSecurityLevel: SecurityLevel.SECRET,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    ...over,
  };
}

/** 带版本号的快照 key（与 UserService.snapshotKey 保持同构） */
function keyOf(userId: string, version = 0): string {
  return `${CACHE_KEY.PERMISSION}${userId}:v${version}`;
}

/**
 * 构造 UserService，并把「数据库中的真实权限」放在可变状态里，
 * 以便模拟「管理员撤权 → 库中权限变了」的场景。
 */
function makeService(initial: { level: SecurityLevel; roles: string[] }, redis = new FakeRedis()) {
  const db = { level: initial.level, roles: [...initial.roles] };

  const repo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
  };

  const service = new UserService(
    repo as never,
    { findOne: vi.fn(async () => null), find: vi.fn(async () => []) } as never,
    { find: vi.fn(async () => []) } as never,
    redis as never,
    { get: () => null } as never,
    // 第 6 参 paramService：仅用于 TTL 取值（security.permission_cache_ttl_seconds）
    { getInt: vi.fn(async () => 300) } as never,
  );

  // 用真实库状态覆盖 buildSnapshot，模拟「权限已变更」。
  // 注意 getSnapshot 内部调用签名是 buildSnapshot(user: AppUser)，
  // 因此这里收到的可能是 user 对象（含 id）也可能是裸 userId 字符串，
  // 两者都归一化，避免夹具与生产调用点不一致造成假红/假绿。
  vi.spyOn(service, 'buildSnapshot').mockImplementation(async (arg: unknown) => {
    const uid = typeof arg === 'string' ? arg : ((arg as { id?: string })?.id ?? 'unknown');
    return snapOf(uid, { maxSecurityLevel: db.level, roles: [...db.roles] });
  });

  return { service, redis, repo, db, buildSnapshot: service.buildSnapshot as unknown as ReturnType<typeof vi.fn> };
}

/** 模拟访问受 SECRET 档案的判定 */
function canReadSecret(snap: PermissionSnapshot): boolean {
  const rank: Record<string, number> = {
    [SecurityLevel.PUBLIC]: 0,
    [SecurityLevel.INTERNAL]: 1,
    [SecurityLevel.SECRET]: 2,
  };
  return (rank[snap.maxSecurityLevel] ?? -1) >= rank[SecurityLevel.SECRET];
}

// ============================================================================
// A 类 · 机制类：测缓存构造本身，单实例结论完整
// ============================================================================
describe('A 类｜缓存机制（多实例不影响其有效性）', () => {
  let h: ReturnType<typeof makeService>;

  beforeEach(() => {
    h = makeService({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] });
  });

  it('A: 首次读取后快照写入版本号 key（perm:{id}:v0）', async () => {
    await h.service.getSnapshot('u-1');
    expect(h.redis.store.has(keyOf('u-1', 0)), '应写入 v0 key').toBe(true);
    expect(h.redis.store.has(`${CACHE_KEY.PERMISSION}u-1`), '不得写入无版本号的旧格式 key').toBe(
      false,
    );
  });

  it('A: 缓存命中时不查库（buildSnapshot 只调用一次）', async () => {
    await h.service.getSnapshot('u-1');
    await h.service.getSnapshot('u-1');
    await h.service.getSnapshot('u-1');
    expect(h.buildSnapshot).toHaveBeenCalledTimes(1);
  });

  it('A: 进程内缓存丢弃后仍能命中 Redis（二级缓存生效）', async () => {
    await h.service.getSnapshot('u-1');
    expect(h.buildSnapshot).toHaveBeenCalledTimes(1);

    // 清进程内缓存（模拟同一实例重启 worker 或 LRU 淘汰）
    (h.service as unknown as { localSnapshotCache: Map<string, unknown> }).localSnapshotCache.clear();

    const again = await h.service.getSnapshot('u-1');
    expect(again.userId).toBe('u-1');
    expect(h.buildSnapshot, 'Redis 应命中，不应回源查库').toHaveBeenCalledTimes(1);
  });

  it('A: 失效后旧版本 key 被清除，新读取重建并写入新版本 key', async () => {
    await h.service.getSnapshot('u-1');
    expect(h.redis.store.has(keyOf('u-1', 0))).toBe(true);

    await h.service.invalidateSnapshot('u-1');
    expect(h.redis.store.has(keyOf('u-1', 0)), '旧版本 key 应被清除').toBe(false);
    expect(h.redis.counters.get(`${CACHE_KEY.PERMISSION_VERSION}u-1`), '版本号应 +1').toBe(1);

    await h.service.getSnapshot('u-1'); // 重建
    expect(h.redis.store.has(keyOf('u-1', 1)), '应写入 v1 key').toBe(true);
  });

  it('A: 精确失效只影响目标用户，不波及无关用户（避免误踢在线用户）', async () => {
    h.redis.store.set(keyOf('u-1', 0), snapOf('u-1'));
    h.redis.store.set(keyOf('u-2', 0), snapOf('u-2'));

    await h.service.invalidateSnapshot('u-1');

    expect(h.redis.store.has(keyOf('u-1', 0)), 'u-1 应被失效').toBe(false);
    expect(h.redis.store.has(keyOf('u-2', 0)), '无关用户 u-2 必须保留').toBe(true);
  });

  it('A: 全量失效覆盖所有用户快照与版本号', async () => {
    for (const id of ['u-1', 'u-2', 'u-3']) {
      h.redis.store.set(keyOf(id, 0), snapOf(id));
      h.redis.counters.set(`${CACHE_KEY.PERMISSION_VERSION}${id}`, 2);
    }

    // userId 缺省 = 全量失效（角色定义/权限矩阵级变更影响所有持有者）
    await h.service.invalidateSnapshot();

    for (const id of ['u-1', 'u-2', 'u-3']) {
      expect(h.redis.store.has(keyOf(id, 0)), `${id} 快照应被失效`).toBe(false);
      expect(h.redis.counters.has(`${CACHE_KEY.PERMISSION_VERSION}${id}`), `${id} 版本号应被清`).toBe(
        false,
      );
    }
  });

  it('A: 版本号计数键带 TTL（避免版本号丢失致旧 key 复活）', async () => {
    const expireSpy = vi.spyOn(h.redis, 'expire');
    await h.service.invalidateSnapshot('u-1');
    expect(expireSpy, 'INCR 后必须设置计数键 TTL').toHaveBeenCalledWith(
      `${CACHE_KEY.PERMISSION_VERSION}u-1`,
      expect.any(Number),
    );
  });

  it('A: Redis 读失败 → 明确抛错或回源，不静默返回空权限快照', async () => {
    vi.spyOn(h.redis, 'getJson').mockRejectedValue(new Error('redis down'));

    // 期望：要么回源成功返回正确快照，要么明确抛错；
    // 不允许静默返回「无权限」快照（会把合法用户全拒），也不允许返回「全权限」。
    const r = await h.service.getSnapshot('u-1').catch((e: unknown) => e);
    if (r instanceof Error) {
      expect(r.message).toContain('redis down');
    } else {
      expect((r as PermissionSnapshot).maxSecurityLevel).toBe(SecurityLevel.SECRET);
    }
  });
});

// ============================================================================
// B 类 · 生效类：撤权后是否真的不能再访问
// 标注：单实例验证通过；多实例语义（版本号 INCR + pub/sub）待工程师 E 包后补测
// ============================================================================
describe('B 类｜撤权生效（单实例验证通过，多实例广播待补）', () => {
  let h: ReturnType<typeof makeService>;

  beforeEach(() => {
    h = makeService({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] });
  });

  it('B: 撤权前密级 SECRET 用户可读 SECRET 档案（基线）', async () => {
    const snap = await h.service.getSnapshot('u-1');
    expect(canReadSecret(snap)).toBe(true);
  });

  it('【关键·安全】B: 撤权 + 主动失效 → 下一次请求立即 403（请求级，非 TTL 等待级）', async () => {
    // 1) 先有一次正常访问，快照已入缓存
    const before = await h.service.getSnapshot('u-1');
    expect(canReadSecret(before)).toBe(true);
    expect(h.redis.store.has(keyOf('u-1', 0))).toBe(true);

    // 2) 管理员撤销权限（库中密级降为 PUBLIC、角色清空）
    h.db.level = SecurityLevel.PUBLIC;
    h.db.roles = [];

    // 3) 撤销操作触发主动失效（PERMISSION_MUTATIONS 每一处入口都必须调用）
    await h.service.invalidateSnapshot('u-1');

    // 4) 紧接着的同一会话请求必须立刻被拒 —— 中间不得有任何等待
    const t0 = Date.now();
    const after = await h.service.getSnapshot('u-1');
    const elapsed = Date.now() - t0;

    expect(canReadSecret(after), '撤权后不得再读 SECRET').toBe(false);
    expect(after.maxSecurityLevel).toBe(SecurityLevel.PUBLIC);
    expect(after.roles).toEqual([]);
    // 断言未发生等待：若此处依赖 TTL（300s）过期，用例根本跑不完/耗时异常
    expect(elapsed, '不得通过 sleep/等待 TTL 实现失效').toBeLessThan(100);
  });

  it('B: 密级下调（SECRET → INTERNAL）同样即时生效', async () => {
    await h.service.getSnapshot('u-1');
    h.db.level = SecurityLevel.INTERNAL;
    await h.service.invalidateSnapshot('u-1');

    const after = await h.service.getSnapshot('u-1');
    expect(canReadSecret(after)).toBe(false);
    expect(after.maxSecurityLevel).toBe(SecurityLevel.INTERNAL);
  });

  it('B: 角色移除后 grants 立即收敛（不留旧角色残留）', async () => {
    const before = await h.service.getSnapshot('u-1');
    expect(before.roles).toContain('R-ARCHIVIST');

    h.db.roles = ['R-VIEWER'];
    await h.service.invalidateSnapshot('u-1');

    const after = await h.service.getSnapshot('u-1');
    expect(after.roles).toEqual(['R-VIEWER']);
    expect(after.roles).not.toContain('R-ARCHIVIST');
  });

  it('B: 连续两次撤权（版本号 0→1→2）每次都能读到最新权限', async () => {
    await h.service.getSnapshot('u-1'); // v0

    h.db.level = SecurityLevel.INTERNAL;
    await h.service.invalidateSnapshot('u-1'); // → v1
    expect((await h.service.getSnapshot('u-1')).maxSecurityLevel).toBe(SecurityLevel.INTERNAL);

    h.db.level = SecurityLevel.PUBLIC;
    await h.service.invalidateSnapshot('u-1'); // → v2
    expect((await h.service.getSnapshot('u-1')).maxSecurityLevel).toBe(SecurityLevel.PUBLIC);

    expect(h.redis.counters.get(`${CACHE_KEY.PERMISSION_VERSION}u-1`)).toBe(2);
    expect(h.buildSnapshot).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------- 多实例（待补）
  it.skip('B【多实例待补】节点 A 撤权 → 节点 B 的进程内缓存必须被广播清掉', async () => {
    // 待工程师 E 包（版本号 + pub/sub）实装后启用。
    // 构造：同一 FakeRedis 上挂两个 UserService 实例（共享 Redis，各自持有 localSnapshotCache）。
    // 断言链：
    //  1) 节点 B getSnapshot → 命中并写入 B 的 localSnapshotCache
    //  2) 节点 A invalidateSnapshot（INCR perm_ver + publish perm:invalidate）
    //  3) 节点 B **不重建 Redis 连接、不清本地缓存**，直接 getSnapshot
    //  4) 必须读到新权限 —— 两条通道任一失效都应使本用例变红：
    //     · 版本号通道：B 计算 key 时 version 已 +1 → 旧 key 天然失配
    //     · 广播通道：B 收到 perm:invalidate 后清掉了 v{n} 的进程内缓存
    // 注意：只用单个实例是测不出来的（本地缓存命中会掩盖广播缺失）→ 假绿高发区。
    const redisA = new FakeRedis();
    const a = makeService({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] }, redisA);
    const b = makeService({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] }, redisA);

    // 模拟 B 已订阅广播通道（onModuleInit 的等价物）
    redisA.subscribers.set(CACHE_KEY.PERMISSION_CHANNEL, [
      (_c, msg) => {
        const payload = JSON.parse(msg) as { userIds?: string[]; all?: boolean };
        const localB = (b.service as unknown as { localSnapshotCache: Map<string, unknown> })
          .localSnapshotCache;
        if (payload.all || !Array.isArray(payload.userIds)) {
          localB.clear();
          return;
        }
        for (const uid of payload.userIds) {
          for (const k of [...localB.keys()]) {
            if (k.startsWith(`${CACHE_KEY.PERMISSION}${uid}:v`)) localB.delete(k);
          }
        }
      },
    ]);

    // 1) B 先读一次，进入本地缓存
    expect((await b.service.getSnapshot('u-1')).maxSecurityLevel).toBe(SecurityLevel.SECRET);

    // 2) A 侧撤权
    a.db.level = SecurityLevel.PUBLIC;
    await a.service.invalidateSnapshot('u-1');

    // 3) B 侧立即再读
    const onB = await b.service.getSnapshot('u-1');
    expect(onB.maxSecurityLevel, '节点 B 也必须立即看到降级后的密级').toBe(SecurityLevel.PUBLIC);
  });

  it.skip('B【多实例待补】广播投递失败时，版本号通道仍应保证正确性', async () => {
    // 待 E 包实装后启用。断言：即使 perm:invalidate 广播全部丢失，
    // 因为 key 含版本号，节点 B 下一次读取也必然落空并重建 → 权限仍正确。
    // 这条区分「广播是锦上添花」与「广播是唯一手段」，避免过度依赖 pub/sub。
  });
});

// ============================================================================
// R 类 · 风险实证：证明「不主动失效」的后果，**不是合规项**
// ============================================================================
describe('R 类｜风险实证（证明风险存在，非合规项）', () => {
  it('R【风险实证】撤权但未调用 invalidate → 旧权限最长存活 300s', async () => {
    // ⚠️ 该用例不是「期望这样」，而是**证明不做主动失效的后果**。
    // C-5 裁定后，它的语义是「断言一个不允许存在的状态」：
    //   · 若本用例变红（读到新权限）→ 说明存在其它生效通道，属意外改进，需核对
    //   · 本用例绿 ≠ 通过验收；它说明 invalidate 调用链若漏一处，就真的漏了 300s
    const h = makeService({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] });

    await h.service.getSnapshot('u-1'); // 快照入缓存（v0）
    h.db.level = SecurityLevel.PUBLIC; // 库中已降级
    // 故意不调用 invalidateSnapshot —— 这正是「调用链漏」的现场

    const stale = await h.service.getSnapshot('u-1');
    expect(stale.maxSecurityLevel, '未失效时读到的是旧快照').toBe(SecurityLevel.SECRET);
    expect(canReadSecret(stale), '这就是越权窗口，必须靠 invalidate 调用链 100% 覆盖堵住').toBe(
      true,
    );
  });
});
