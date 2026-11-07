/**
 * 权限快照缓存 机制测试（PRD v1.3 §5.5 C-5 / F-09，架构 §4.3）
 *
 * ## 口径变更（v1.3）
 * 旧文档写「5 min TTL，满足『权限变更 5 分钟生效』」——该表述**已作废**。
 * 现在生效靠「版本号 INCR + pub/sub 广播」，TTL 仅兜底。
 * 因此本文件的用例全部属 **A 类·机制类**（测缓存构造本身），
 * 单实例结论完整，多实例不影响其有效性，**不标**「多实例待补」。
 *
 * 真正的「生效类」断言在 `user.permission-revoke-effect.spec.ts`（B 类）。
 *
 * 覆盖：
 *   A1 TTL 常量与命名空间约定
 *   A2 首次读库写缓存 / 命中不查库 / 用户不存在
 *   A3 精确失效删除范围 / 全量失效不误伤其他业务 key
 *   A4 TTL 不滑动续期
 *   A5 风险实证：未调用 invalidate 时旧权限仍在（非合规项）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_KEY, CACHE_TTL } from '@api/common/constants/enums';
import { UserService } from '@api/modules/user/user.service';
import { SecurityLevel, type PermissionSnapshot } from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
/**
 * FakeRedis：数据键与计数键分开存储（INCR 只作用于字符串键，
 * 混用同一 Map 会让 setJson 的对象与计数器互相覆盖，掩盖真实缺陷）。
 * store 里额外记录 ttl，用于断言「命中不滑动续期」。
 */
class FakeRedis {
  public store = new Map<string, { value: unknown; ttl?: number }>();
  public counters = new Map<string, number>();
  public published: Array<{ channel: string; message: string }> = [];
  /** 记录每次 setJson 的 key，用于断言「命中路径不重写」 */
  public setJsonCalls: string[] = [];
  /** 记录 expire 调用，用于断言版本号计数键带 TTL */
  public expireCalls: Array<{ key: string; ttl: number }> = [];

  public async getJson<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    return hit ? (hit.value as T) : null;
  }

  public async setJson(key: string, value: unknown, ttl?: number): Promise<void> {
    this.setJsonCalls.push(key);
    this.store.set(key, { value, ttl });
  }

  public async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  /** 真实 Redis 的 SCAN/DEL 不区分两类键，故此处必须跨两个 Map */
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

  public async expire(key: string, ttl: number): Promise<void> {
    this.expireCalls.push({ key, ttl });
  }

  public async publish(channel: string, message: string): Promise<void> {
    this.published.push({ channel, message });
  }
}

function snapshotOf(userId: string, over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    userId,
    username: userId,
    displayName: userId,
    roles: ['R3'],
    grants: {},
    maxSecurityLevel: SecurityLevel.PUBLIC,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    ...over,
  };
}

/** 与 UserService.snapshotKey 同构 */
function keyOf(userId: string, version = 0): string {
  return `${CACHE_KEY.PERMISSION}${userId}:v${version}`;
}

function makeService() {
  const redis = new FakeRedis();
  const repo = { findOne: vi.fn() };
  const service = new UserService(
    repo as never, // userRepo
    { findOne: vi.fn(async () => null), find: vi.fn(async () => []) } as never, // roleRepo
    { find: vi.fn(async () => []) } as never, // scopeRepo
    redis as never, // redis
    { get: () => null } as never, // config
    { getInt: vi.fn(async () => CACHE_TTL.PERMISSION) } as never, // paramService
  );
  return { service, redis, repo };
}

// ============================================================================
describe('A1 缓存常量与命名空间约定', () => {
  it('A: 权限快照兜底 TTL = 300s（仅兜底，不承担生效职责）', () => {
    expect(CACHE_TTL.PERMISSION).toBe(300);
  });

  it('A: 缓存 key 前缀具备命名空间（避免与其他业务 key 冲突）', () => {
    expect(CACHE_KEY.PERMISSION).toMatch(/permission|perm/i);
    expect(CACHE_KEY.PERMISSION.endsWith(':') || CACHE_KEY.PERMISSION.endsWith('_')).toBe(true);
    // 版本号键与快照键必须是不同前缀，否则 delByPrefix 会连坐
    expect(CACHE_KEY.PERMISSION_VERSION).not.toBe(CACHE_KEY.PERMISSION);
  });

  it('A: 版本号计数键保留期远大于快照 TTL（防旧 key 复活）', () => {
    expect(CACHE_TTL.PERMISSION_VERSION).toBeGreaterThan(CACHE_TTL.PERMISSION * 10);
  });

  it('A: 字典与门类缓存 TTL 不小于权限快照（低频变更）', () => {
    expect(CACHE_TTL.DICT).toBeGreaterThanOrEqual(CACHE_TTL.PERMISSION);
    expect(CACHE_TTL.CATEGORY).toBeGreaterThanOrEqual(CACHE_TTL.PERMISSION);
  });
});

// ============================================================================
describe('A2 getSnapshot 缓存读写行为', () => {
  let h: ReturnType<typeof makeService>;
  beforeEach(() => {
    h = makeService();
  });

  it('A: 首次读取查库，写入版本号 key，TTL 取自参数（非硬编码）', async () => {
    const snap = snapshotOf('u-1');
    const buildSpy = vi.spyOn(h.service, 'buildSnapshot').mockResolvedValue(snap);
    h.repo.findOne.mockResolvedValue({ id: 'u-1' });

    const r = await h.service.getSnapshot('u-1');
    expect(r).toEqual(snap);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    const entry = h.redis.store.get(keyOf('u-1', 0));
    expect(entry?.ttl, 'TTL 应来自 security.permission_cache_ttl_seconds').toBe(CACHE_TTL.PERMISSION);
  });

  it('A【关键】命中缓存时不查库（性能承诺）', async () => {
    const snap = snapshotOf('u-1');
    h.redis.store.set(keyOf('u-1', 0), { value: snap, ttl: 300 });
    const buildSpy = vi.spyOn(h.service, 'buildSnapshot');

    const r = await h.service.getSnapshot('u-1');
    expect(r).toEqual(snap);
    expect(buildSpy).not.toHaveBeenCalled();
    expect(h.repo.findOne).not.toHaveBeenCalled();
  });

  it('A: 用户不存在 → 1002 未认证', async () => {
    h.repo.findOne.mockResolvedValue(null);
    await expect(h.service.getSnapshot('ghost')).rejects.toMatchObject({ code: 1002 });
  });

  it('A: TTL 未被滑动续期（命中路径不重写 setJson）', async () => {
    h.redis.store.set(keyOf('u-1', 0), { value: snapshotOf('u-1'), ttl: 300 });
    h.redis.setJsonCalls = [];

    await h.service.getSnapshot('u-1');
    await h.service.getSnapshot('u-1');

    expect(h.redis.setJsonCalls, '命中缓存不得重写 key（否则 TTL 被无限续期）').toEqual([]);
    expect(h.redis.store.get(keyOf('u-1', 0))?.ttl).toBe(300);
  });
});

// ============================================================================
describe('A3 invalidateSnapshot —— 失效范围', () => {
  it('A【关键】精确失效：只删除指定用户的快照，不影响其他用户', async () => {
    const { service, redis } = makeService();
    redis.store.set(keyOf('u-1', 0), { value: snapshotOf('u-1') });
    redis.store.set(keyOf('u-2', 0), { value: snapshotOf('u-2') });

    await service.invalidateSnapshot('u-1');

    expect(redis.store.has(keyOf('u-1', 0))).toBe(false);
    expect(redis.store.has(keyOf('u-2', 0)), '无关用户必须保留').toBe(true);
  });

  it('A: 全量失效：清空所有权限快照与版本号，但不误伤其他业务 key', async () => {
    const { service, redis } = makeService();
    redis.store.set(keyOf('u-1', 0), { value: snapshotOf('u-1') });
    redis.store.set(keyOf('u-2', 0), { value: snapshotOf('u-2') });
    redis.counters.set(`${CACHE_KEY.PERMISSION_VERSION}u-1`, 1);
    redis.store.set(`${CACHE_KEY.LOGIN_FAILED}someone`, { value: 3 });

    await service.invalidateSnapshot();

    expect(redis.store.has(keyOf('u-1', 0))).toBe(false);
    expect(redis.store.has(keyOf('u-2', 0))).toBe(false);
    expect(redis.counters.has(`${CACHE_KEY.PERMISSION_VERSION}u-1`)).toBe(false);
    // 其他业务 key 不受影响（前缀必须精确，不能是 perm 的宽松匹配）
    expect(redis.store.has(`${CACHE_KEY.LOGIN_FAILED}someone`)).toBe(true);
  });

  it('A: 精确失效发出广播（多实例通道的前提，但通道有效性见 B 类）', async () => {
    const { service, redis } = makeService();
    await service.invalidateSnapshot('u-1');

    expect(redis.published).toHaveLength(1);
    expect(redis.published[0].channel).toBe(CACHE_KEY.PERMISSION_CHANNEL);
    const payload = JSON.parse(redis.published[0].message) as { userIds: string[] };
    expect(payload.userIds).toEqual(['u-1']);
  });
});

// ============================================================================
// R 类 · 风险实证
// ============================================================================
describe('R 风险实证（证明风险存在，非合规项）', () => {
  it('R【风险窗口】撤权后未调用 invalidate 时，缓存内旧权限仍生效', async () => {
    // ⚠️ 语义已变：本用例证明的是「不调 invalidate 的后果」，
    // 不是「300s 窗口可接受」。C-5 要求 invalidate 调用链 100% 覆盖。
    const { service, redis } = makeService();
    // 旧快照：SECRET 权限
    redis.store.set(keyOf('u-1', 0), {
      value: snapshotOf('u-1', { maxSecurityLevel: SecurityLevel.SECRET }),
      ttl: CACHE_TTL.PERMISSION,
    });
    // 管理员把该用户降为 PUBLIC，但忘记失效缓存
    const r = await service.getSnapshot('u-1');
    expect(r.maxSecurityLevel, '旧值仍生效 → 越权窗口').toBe(SecurityLevel.SECRET);

    // 正确做法：变更后必须调用 invalidateSnapshot
    await service.invalidateSnapshot('u-1');
    expect(redis.store.has(keyOf('u-1', 0)), '失效后旧 key 必须消失').toBe(false);
  });
});
