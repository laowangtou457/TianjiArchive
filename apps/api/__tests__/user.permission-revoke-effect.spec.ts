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
 * **B 类·生效类**（`B:` 前缀）：测「撤权后真的不能再访问」。单实例验证通过；
 *   多实例语义（版本号 INCR + pub/sub 广播）由 **T 类**覆盖（原 2 条 `it.skip` 已启封）。
 *
 * **T 类·多实例双通道**（`T:` 前缀）：测「同一 Redis 上的两个实例」的失效语义。
 *   拆成 T1 版本号通道 / T2 广播通道 / T3 端到端，让两条通道**各自可独立变红**。
 *   关键：不能只用「B 读到新值」断言 —— 版本号通道会让它无条件变绿，
 *   从而掩护广播通道整体失效（搭便车假绿）。详见 T 类头部说明。
 *
 * **R 类·风险实证**（`R:` 前缀）：证明「不做主动失效会怎样」。
 *   C-5 裁定后，此类用例**证明的是风险存在，不是合规项**——
 *   不得与「已验证项」并列计入通过清单，否则读者会读出
 *   「300s 窗口是设计可接受的」。C-5 达标线是 invalidate 调用链 100% 覆盖。
 *
 * ## 两种漏法的区别（报告中分两栏，不可混为一谈）
 *  - 多实例漏 = 广播没发出去（版本号/广播通道失效）→ T 类覆盖
 *  - 调用链漏 = invalidate 压根没被调用（PERMISSION_MUTATIONS 遗漏入口）→ 一致性测试覆盖
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
  /** 已订阅的通道 → 回调（供测试自建订阅者使用；生产路径请用 duplicate()） */
  public subscribers = new Map<string, Array<(channel: string, message: string) => void>>();
  /** 所有 duplicate() 出的订阅连接在 publish 时收到的广播钩子 */
  public broadcastHooks: Array<(channel: string, message: string) => void> = [];

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
    // 投递给所有 duplicate() 出的真实订阅连接（走 onModuleInit 的系统）
    for (const hook of this.broadcastHooks) hook(channel, message);
  }

  public async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : String(v);
  }

  public async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  // -------------------------------------------------------------- pub/sub 接口
  /**
   * 复刻 `RedisService.duplicateForSubscribe()`：返回一条独立的订阅专用连接。
   *
   * 注意方法名：生产代码调的是服务层的 `duplicateForSubscribe()`，
   * 它内部才调 ioredis 的 `client.duplicate()`。本夹具直接替换整个 RedisService，
   * 因此必须暴露**服务层**的方法名，否则 `onModuleInit` 会抛 TypeError
   * 并被它自己的 try/catch 静默吞掉（订阅悄无声息地没建立，用例却可能假绿）。
   *
   * 返回的对象共享本 FakeRedis 的广播总线（正如真实 Redis 的多条连接共享
   * 同一 PUBSUB 总线），但拥有独立的订阅记录与监听器。
   *
   * **为什么要实现它**：`UserService.onModuleInit` 走的是
   * `duplicateForSubscribe()` → `.subscribe()` → `.on('message')`。
   * 若不实现这套接口，多实例用例只能用测试里自建的替身回调去「模拟」广播消费，
   * 那样断言的只是替身的行为，**生产代码里的 `handlePermissionInvalidate`
   * 被整个删掉用例依然全绿**（实测过：变异后 0 红）。实现了才能真正打到生产路径。
   */
  public duplicateForSubscribe(): FakeRedisSubscriber {
    const sub = new FakeRedisSubscriber(this);
    this.duplicated.push(sub);
    return sub;
  }

  /** `duplicateForSubscribe()` 产生的订阅连接（供用例断言/清理） */
  public duplicated: FakeRedisSubscriber[] = [];
}

/**
 * 订阅专用连接，只实现 `UserService` / `ParamService` 实际用到的那几个方法：
 * `subscribe` / `unsubscribe` / `on` / `quit`。
 */
class FakeRedisSubscriber {
  /** 该连接当前订阅的通道 */
  public readonly channels = new Set<string>();
  /** `'message'` 事件的监听器 */
  public readonly messageHandlers: Array<(channel: string, message: string) => void> = [];

  public constructor(private readonly owner: FakeRedis) {
    // 挂到 owner 的广播注册表：owner.publish 时会回调到这些 handler
    this.owner.broadcastHooks.push((channel: string, message: string) => {
      if (!this.channels.has(channel)) return;
      for (const h of this.messageHandlers) h(channel, message);
    });
  }

  public async subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
  }

  public async unsubscribe(channel: string): Promise<void> {
    this.channels.delete(channel);
  }

  /** 复刻 ioredis 的 EventEmitter 接口（仅 `message` 事件被使用） */
  public on(event: 'message', handler: (channel: string, message: string) => void): this {
    if (event === 'message') this.messageHandlers.push(handler);
    return this;
  }

  public async quit(): Promise<void> {
    this.channels.clear();
    this.messageHandlers.length = 0;
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

/** 模拟「数据库中的真实权限」的可变状态 */
interface FakeDb {
  level: SecurityLevel;
  roles: string[];
}

function newFakeDb(initial: { level: SecurityLevel; roles: string[] }): FakeDb {
  return { level: initial.level, roles: [...initial.roles] };
}

/**
 * 构造 UserService，并把「数据库中的真实权限」放在可变状态里，
 * 以便模拟「管理员撤权 → 库中权限变了」的场景。
 *
 * ## `sharedDb` 参数（多实例测试专用）
 *
 * 生产里两个 api 容器连的是**同一个 PostgreSQL**，因此「库中权限」是全局唯一的一份。
 * 默认每次调用都新建一份 FakeDb，适合单实例用例（A/B 类）；
 * 多实例用例（T 类）必须传同一个 `sharedDb`，否则两个实例各持一份库，
 * 出现「A 侧撤权只改了 a.db，B 回源重建仍读到自己那份旧 b.db」的**夹具假红**。
 * 这类错误极易被误读为「生产代码失效」，实测踩过一次，故显式参数化。
 */
function makeService(
  initial: { level: SecurityLevel; roles: string[] },
  redis = new FakeRedis(),
  sharedDb?: FakeDb,
) {
  const db: FakeDb = sharedDb ?? newFakeDb(initial);

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
describe('B 类｜撤权生效（单实例；多实例语义见 T 类）', () => {
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

  // ------------------------------------------------- 多实例双通道（已启封 · 见文末 T 类）
  // 原 2 条 `it.skip`（「多实例待补」）已拆为下方 T 类 3 条真实用例。
  // 不保留原第 1 条的「读新值」形态，原因见 T1/T2 头部说明：
  // 仅断言「B 读到新值」无法区分是哪条通道生效 —— 版本号通道会让它无条件变绿，
  // 从而掩护「广播通道整个失效」，属搭便车假绿。拆开后两通道各自可独立变红。
});

// ============================================================================
// T 类 · 多实例双通道（C-5：版本号通道 vs 广播通道）
// ============================================================================
//
// ## 构造：同进程双实例，共享同一 FakeRedis
//
// 两个 `UserService` 实例各持一份 `localSnapshotCache`，但 `perm_ver:{id}`
// 计数键与 `perm:{id}:v{n}` 数据键都在同一个 FakeRedis 上 —— 这正是生产里
// 两个 api 容器连同一个 Redis 的等价形态。**不需要第二个容器**：多实例的
// 本质差异是「进程内缓存不共享」，用两个实例对象即可精确复现。
//
// ## 关键前提：键位分离模型
//
// `getSnapshot` 的 key 由 `perm_ver:{id}` 实时算出：
//
//     version = getCounter('perm_ver:u-1')   // 0 → 1
//     cacheKey = `perm:u-1:v${version}`      // perm:u-1:v0 → perm:u-1:v1
//
// 所以版本号 +1 之后，**即便广播完全丢失**，B 也会因为算出全新的 key
// 而落空并回源重建。结论：
//   · 「B 读到新值」**不能**证明广播通道有效 —— 版本号通道会无条件兜住；
//   · 要证明广播有效，必须直接断言**进程内缓存被清空**这个副作用本身（T2）。
//
// ## 两通道的职责分工（断言必须各自指向自己的闸门）
//
// | 通道        | 机制                              | 单独失效时的后果            | 覆盖用例 |
// |-------------|-----------------------------------|-----------------------------|----------|
// | 版本号通道  | `INCR perm_ver:{id}` → key 换名   | 跨实例仍读到旧权限（越权）  | T1       |
// | 广播通道    | `publish perm:invalidate` → 清本地 | Redis 多打一次（性能退化）  | T2       |
//
// 注意 T2 单独失效**不会**造成越权（T1 会兜住），它的价值是省掉一次 Redis 回源。
// 因此 T2 不能用「读到新值」来断言，只能断言缓存被清空。
describe('T 类｜多实例双通道（版本号 vs 广播）', () => {
  /** 取某实例的进程内缓存（私有字段，测试专用视图） */
  function localCacheOf(service: UserService): Map<string, unknown> {
    return (service as unknown as { localSnapshotCache: Map<string, unknown> }).localSnapshotCache;
  }

  /** 取某实例的 db 可变状态（`makeService` 返回值里的 db 引用） */
  type Handle = ReturnType<typeof makeService>;

  /**
   * 让 `target` 走**真实的** `onModuleInit` 订阅权限失效通道。
   *
   * 走生产代码路径是本用例组的关键：最初版本在测试里手写一个回调来「模拟」
   * 广播消费，结果变异验证（禁用 `handlePermissionInvalidate`）**0 红** ——
   * 因为断言打的是替身而非生产代码。现在 FakeRedis 实现了 `duplicate()`
   * + `subscribe/on/quit`，`onModuleInit` 原样跑通，生产逻辑被真正覆盖。
   *
   * 若将来 `onModuleInit` 的订阅姿势改变（例如改用 `psubscribe`），
   * FakeRedis 缺少对应方法会直接抛错，属显式失败而非静默假绿。
   */
  async function subscribeReal(redis: FakeRedis, target: Handle): Promise<void> {
    await target.service.onModuleInit();
  }

  /** 建两个共享同一 Redis + 同一「数据库」的实例（A = 操作方，B = 旁观方） */
  function makeCluster(): { redis: FakeRedis; db: FakeDb; a: Handle; b: Handle } {
    const redis = new FakeRedis();
    // 关键：共享 db —— 生产里两个容器连同一个 PostgreSQL，权限数据全局唯一
    const db = newFakeDb({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] });
    const a = makeService({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] }, redis, db);
    const b = makeService({ level: SecurityLevel.SECRET, roles: ['R-ARCHIVIST'] }, redis, db);
    return { redis, db, a, b };
  }

  // ---------------------------------------------------------------- T1 版本号通道
  it('T1: 广播全部丢失时，版本号通道仍保证 B 读到最新权限', async () => {
    // 【本用例在测哪道闸门】版本号通道（`INCR perm_ver`）。
    // 构造上**刻意不挂任何订阅者** —— 等价于 pub/sub 全链路故障、消息全部丢失。
    // 此时 B 仍必须读到新权限，因为 key 里含版本号，旧 key 天然失配。
    // 若这条变红 → 说明「撤权即时生效」在广播故障时会退化为 300s 越权窗口。
    const { redis, db, a, b } = makeCluster();
    // 前置：确认真没有订阅者，否则本用例退化为 T3（测不出广播丢失下的兜底）
    expect(
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      redis.subscribers.get(CACHE_KEY.PERMISSION_CHANNEL) ?? [],
      'T1 必须无订阅者：广播全丢是本用例的构造前提',
    ).toHaveLength(0);

    // 1) B 先读一次 → 快照进入 B 的进程内缓存（v0）
    expect((await b.service.getSnapshot('u-1')).maxSecurityLevel).toBe(SecurityLevel.SECRET);
    expect(localCacheOf(b.service).has(keyOf('u-1', 0)), 'B 本地缓存应有 v0').toBe(true);

    // 2) A 侧撤权：INCR perm_ver → 1，publish 无人接收（无订阅者）
    db.level = SecurityLevel.PUBLIC;
    await a.service.invalidateSnapshot('u-1');

    // 3) B 立即再读 —— 版本号已是 v1，v0 key 失配 → 回源重建
    const onB = await b.service.getSnapshot('u-1');
    expect(onB.maxSecurityLevel, '版本号通道必须独立兜住，不依赖广播').toBe(SecurityLevel.PUBLIC);

    // 4) 反向确认「广播确实没参与」：v0 是 A 主动 del 掉的（清理职责），
    //    不是 B 的订阅者清掉的（B 根本没订阅）。这条排除「B 靠别的途径生效」。
    expect(
      redis.subscribers.get(CACHE_KEY.PERMISSION_CHANNEL) ?? [],
      '全程不得有订阅者介入',
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------- T2 广播通道
  it('T2: 广播必须真的清掉 B 的进程内缓存（断言副作用，不断言读值）', async () => {
    // 【本用例在测哪道闸门】广播通道（`publish perm:invalidate` → 清进程内缓存）。
    //
    // ⚠️ 断言设计的核心：**不能断言「B 读到新值」**。
    //    因为版本号通道会让 B 无条件读到新值（见 T 类头部说明），
    //    那种写法在 `handlePermissionInvalidate` 被整个删除后仍然全绿 —— 假绿。
    //    本用例直接断言「B 的 localSnapshotCache 被清空」这个**广播独有的副作用**，
    //    它是唯一能把广播通道单独钉死的可观测点。
    const { redis, db, a, b } = makeCluster();
    await subscribeReal(redis, b); // 走真实 onModuleInit 订阅

    // ---- 前置断言：先证明试验台搭对了，否则后面的断言会空转 ----------------
    // 若 B 读完之后本地缓存里根本没有 v0，那么「清空」断言必然通过，
    // 但什么也没验证到（空 Map 天然满足 toHaveLength(0)）。
    expect((await b.service.getSnapshot('u-1')).maxSecurityLevel).toBe(SecurityLevel.SECRET);
    expect(
      localCacheOf(b.service).has(keyOf('u-1', 0)),
      '前置：B 首次读取后本地缓存必须存在 v0，否则本用例无法证明任何事',
    ).toBe(true);
    expect(localCacheOf(b.service).size, '前置：本地缓存非空').toBeGreaterThan(0);

    // ---- 动作：A 撤权（INCR + publish）------------------------------------
    db.level = SecurityLevel.PUBLIC;
    await a.service.invalidateSnapshot('u-1');

    // ---- 断言：广播的副作用（缓存被清空），而非「B 读到新值」 --------------
    expect(
      localCacheOf(b.service).size,
      'B 收到 perm:invalidate 后进程内缓存必须被清空（广播通道的唯一可观测职责）',
    ).toBe(0);
    expect(localCacheOf(b.service).has(keyOf('u-1', 0)), 'v0 必须已被清除').toBe(false);
  });

  // ---------------------------------------------------------------- T3 端到端
  it('T3【端到端】两通道并存，B 必须立即看到降级后的权限', async () => {
    // 【本用例在测哪道闸门】组合正确性 —— 用户视角的最终结论。
    // T1/T2 各自只覆盖一条通道，理论上仍存在「两条各自对、组合起来错」的空间
    // （例如广播把新 key 也误删、或清缓存与重建发生竞态）。
    // 本条按生产真实形态（双通道都在）验证：撤权后 B 的下一次读取必须是新权限。
    //
    // 注意它的断言**不能替代** T1/T2：这条绿不代表两通道各自有效，
    // 只有 T1 红时才是兜底失效，只有 T2 红时才是广播失效，本条只负责「合起来对」。
    const { redis, db, a, b } = makeCluster();
    await subscribeReal(redis, b);

    expect((await b.service.getSnapshot('u-1')).maxSecurityLevel).toBe(SecurityLevel.SECRET);

    db.level = SecurityLevel.PUBLIC;
    await a.service.invalidateSnapshot('u-1');

    const onB = await b.service.getSnapshot('u-1');
    expect(onB.maxSecurityLevel, '节点 B 必须立即看到降级后的密级').toBe(SecurityLevel.PUBLIC);
    expect(onB.roles, '角色也必须随之收敛').toEqual(['R-ARCHIVIST']);
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
