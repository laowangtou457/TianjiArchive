/**
 * C-5 请求级硬用例（PRD v1.3 §5.5 C-5 / F-09）
 *
 * ## 为什么还要有这一个文件
 *
 * `user.permission-revoke-effect.spec.ts` 的 B 类用例断言的是
 * **`UserService.getSnapshot()` 返回的快照已经不含该权限**——
 * 这在 service 层是成立的，但它默认了一件事：
 * 「上层 Guard 一定读的是这份快照，并且一定做了判定」。
 *
 * team-lead 的验收口径原文是「撤权后**当前会话下一次请求立即 403**（请求级断言）」，字面
 * 要求走「HTTP 入口 → 守卫 → 业务」这条链，而不是停在 service。二者不是一回事：
 *
 *  - service 层绿 + Guard 读错字段（例如读了 token 内嵌快照而非 request.user）
 *    → 请求照样放行，越权真实存在，而 B 类用例全绿（**假绿**）；
 *  - service 层绿 + Controller 漏了 `@RequirePerm` → 同样放行。
 *
 * 本文件因此把链路拉全：
 *
 *   `PermissionGuard`（真实源码）
 *        ↑ request.user 由 **真实的 `JwtStrategy.validate()`**（真实源码）产出
 *        ↑ `UserService.getSnapshot()`（真实源码，FakeRedis 模拟共享 Redis）
 *        ↑ Controller 方法上的 **真实 `@RequirePerm` 元数据**（import 真身，不手抄）
 *
 * 唯一被替换的是 PG / TypeORM（`findOne` / `find` 返回内存对象）与 Redis（FakeRedis）。
 *
 * ## 禁止的写法
 *
 * - 不使用 `sleep` / 假等待 TTL 过期。撤权后的判定必须是**同进程下一次调用即生效**；
 * - 不使用 `expect(...).rejects` 之外的时间断言。这里断言的是 `elapsed < 100ms`，
 *   若实现退化成「等缓存过期」，本用例会因耗时变红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  PermissionDomain,
  PermissionMode,
  SecurityLevel,
  type OperationType,
  type PermissionSnapshot,
} from '@tianji/shared';
import { CACHE_KEY, CTX_KEY, META_KEY } from '@api/common/constants/enums';
import { PermissionGuard } from '@api/common/guards/permission.guard';
import { RequirePerm } from '@api/common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '@api/common/types/authenticated-user';
import { UserService } from '@api/modules/user/user.service';
import { JwtStrategy } from '@api/modules/auth/strategies/jwt.strategy';
import { ArchiveController } from '@api/modules/archive/archive.controller';
import type { AppConfig } from '@api/config/configuration';

// ------------------------------------------------------------------ FakeRedis
/**
 * 与 `user.permission-revoke-effect.spec.ts` 同构的最小实现。
 * 只覆盖 UserService 实际用到的 6 个命令：getJson / setJson / del / delByPrefix /
 * incr / expire / publish。**两个 Map**（数据键 + 计数键）不可合并，
 * 否则 INCR 会把已缓存的对象覆盖成数字（见报告 §8.3）。
 */
class FakeRedis {
  public store = new Map<string, unknown>();
  public counters = new Map<string, number>();

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
    /* 单测不实现 TTL 到期；本文件也禁止靠 TTL 生效 */
  }

  public async publish(_channel: string, _message: string): Promise<void> {
    /* 单实例场景无需投递 */
  }

  public async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : String(v);
  }

  public async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

// ------------------------------------------------------------------ 权限夹具
/** 档案员：可读文件级著录（ITEM:READ），上限 SECRET */
function archivistsGrants(): PermissionSnapshot['grants'] {
  return {
    [PermissionDomain.ITEM]: {
      domain: PermissionDomain.ITEM,
      ops: ['READ', 'WRITE'] as OperationType[],
      mode: PermissionMode.FULL,
    },
  };
}

function snapOf(userId: string, over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    userId,
    username: userId,
    displayName: userId,
    roles: ['R-ARCHIVIST'],
    grants: archivistsGrants(),
    maxSecurityLevel: SecurityLevel.SECRET,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    ...over,
  };
}

// ------------------------------------------------------------------ 链路夹具
/**
 * 把「PG 里的用户行 + 用户当前权限 + Redis」组装成一条**真实的**请求链路。
 *
 * 返回的 `request` 是一个普通的 express Request 替身；`run()` 做的事和 Nest 运行时
 * 完全一致：先跑 JwtStrategy.validate（真实源码）拿到 currentUser，再跑
 * PermissionGuard.canActivate（真实源码）判定，最后才调用 Controller 方法。
 */
function makeChain(db: Partial<PermissionSnapshot> = {}) {
  const redis = new FakeRedis();

  // 库中的用户行（JwtStrategy 会 findById → assertUserUsable → getSnapshot）
  const userRow = {
    id: 'u-1',
    username: 'zhangsan',
    displayName: '张三',
    status: 'ACTIVE',
    maxSecurityLevel: SecurityLevel.SECRET,
    lockedUntil: null as Date | null,
    passwordHash: 'x',
  };

  const userService = new UserService(
    { findOne: vi.fn(async () => userRow), find: vi.fn(async () => [userRow]) } as never,
    { findOne: vi.fn(async () => null), find: vi.fn(async () => []) } as never,
    { find: vi.fn(async () => []) } as never,
    redis as never,
    { get: () => null } as never,
    { getInt: vi.fn(async () => 300) } as never,
  );

  // 库中的「当前权限」——撤权就是改这里
  const live: { snapshot: PermissionSnapshot } = { snapshot: snapOf('u-1', db) };
  vi.spyOn(userService, 'buildSnapshot').mockImplementation(async (arg: unknown) => {
    const uid = typeof arg === 'string' ? arg : ((arg as { id?: string })?.id ?? 'unknown');
    return { ...live.snapshot, userId: uid };
  });
  // assertUserUsable 走真实实现（userRow.status 为 ACTIVE，直接放行）

  const jwt = new JwtStrategy(
    { get: () => ({ accessSecret: 'test_secret_at_least_32_chars_long_ok' }) as AppConfig['jwt'] } as never,
    userService,
  );

  const reflector = new Reflector();
  const guard = new PermissionGuard(reflector);

  /** 构造一个挂载了真实 @RequirePerm 元数据的 ExecutionContext */
  function ctxOf(handler: (...args: never[]) => unknown, request: Record<string, unknown>) {
    const ctx = {
      getHandler: () => handler,
      getClass: () => ArchiveController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return ctx;
  }

  /**
   * 跑一次完整请求（认证 → 鉴权 → 业务入口）。
   *
   * 只到「Guard 放行」为止：Controller 方法内部依赖 ArchiveService，
   * 那属于业务正确性，不在 C-5 撤权语义的验证范围内（见同目录 archive.* 用例）。
   */
  async function run() {
    // 1) 认证：JwtStrategy.validate（真实源码）→ currentUser
    const currentUser = (await jwt.validate({
      sub: 'u-1',
      username: 'zhangsan',
      sessionId: 'sid-1',
      type: 'access',
    })) as AuthenticatedUser;

    const request: Record<string, unknown> = {
      method: 'GET',
      originalUrl: '/api/archive/items?page=1&size=20',
      headers: {},
      body: {},
      query: {},
      params: {},
      [CTX_KEY.USER]: currentUser,
    };

    // 2) 鉴权：PermissionGuard（真实源码）判定 Controller.listItems 上的 @RequirePerm
    const ctx = ctxOf(ArchiveController.prototype.listItems as never, request);
    guard.canActivate(ctx);

    return { currentUser, request };
  }

  /** 管理员撤权：既改库，也调用真实的 invalidateSnapshot */
  async function revoke(over: Partial<PermissionSnapshot>) {
    live.snapshot = { ...live.snapshot, ...over };
    await userService.invalidateSnapshot('u-1');
  }

  return { redis, userService, jwt, guard, reflector, run, revoke, live, ctxOf, userRow };
}

// ============================================================================
// 前置自检：确保夹具本身不是假绿来源
// ============================================================================
describe('前置自检｜元数据与夹具可信度', () => {
  it('Controller.listItems 上确实挂了 @RequirePerm（从真身读取，不手抄）', () => {
    // ⚠️ 必须用 getAllAndOverride（等价于 Guard 内部读取方式）：
    // SetMetadata 挂在 prototype 方法上，而 Reflector.get(key, [handler, class])
    // 只按 owned metadata 逐 target 查，取不到 prototype 上的元数据 → 会返回 undefined。
    // 我第一次写时就踩了这个坑（见报告「本轮自省」），它会让「前置自检」假红、也可能让
    // 后续「漏挂 @RequirePerm」的真缺陷被误读成夹具问题。
    const reflector = new Reflector();
    const meta = reflector.getAllAndOverride<{ domain: string; op: string } | undefined>(
      META_KEY.REQUIRE_PERM,
      [ArchiveController.prototype.listItems as never, ArchiveController as never],
    );
    expect(meta, 'Controller 漏挂 @RequirePerm 会让请求级用例全部假绿').toBeDefined();
    expect(meta?.domain).toBe(PermissionDomain.ITEM);
    expect(meta?.op).toBe('READ');
    // RequirePerm 是纯 SetMetadata 装饰器，这里顺带确认它没有被替换成空实现
    expect(typeof RequirePerm).toBe('function');
  });

  it('夹具自检：无版本号旧 key 不会被写入（否则下面的版本号断言失效）', async () => {
    const h = makeChain();
    await h.run();
    expect(h.redis.store.has(`${CACHE_KEY.PERMISSION}u-1`)).toBe(false);
    expect(h.redis.store.has(`${CACHE_KEY.PERMISSION}u-1:v0`)).toBe(true);
  });
});

// ============================================================================
// 请求级硬用例（team-lead 验收口径）
// ============================================================================
describe('请求级｜撤权后当前会话的下一次请求必须立即 403', () => {
  let h: ReturnType<typeof makeChain>;

  beforeEach(() => {
    h = makeChain();
  });

  /**
   * 断言「这次请求被 Guard 拒了，且拒因是 403 越权」。
   *
   * 两个坑（都是我自己第一次写时踩的，记下来免得后人重犯）：
   *  1) `ErrorCode.FORBIDDEN` 是 **ErrorCodeDef 对象**（`{code, httpStatus, message}`），
   *     不是数字。写 `.toBe(ErrorCode.FORBIDDEN)` 会拿对象比数字 → 永远失败。
   *  2) `rejects.toMatchObject({ code: ... })` 同样不适合，因为 `expected` 里传的也是对象，
   *     Vitest 会用对象去做深度匹配，报错信息反而误导成「实际值缺失字段」。
   */
  async function expectForbidden(p: Promise<unknown>): Promise<BizException> {
    let caught: unknown = null;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught, '请求应被拒绝，但实际放行了（越权！）').toBeInstanceOf(BizException);
    const biz = caught as BizException;
    expect(biz.code, '必须是 FORBIDDEN(1003)，不能是 401 或其他').toBe(ErrorCode.FORBIDDEN.code);
    expect(biz.httpStatus).toBe(ErrorCode.FORBIDDEN.httpStatus);
    return biz;
  }

  it('【核心】撤 ITEM 权限后，同一个未刷新 token 的下一次请求被 Guard 拒绝', async () => {
    // Arrange：先成功访问一次，确认权限缓存已被填充（v0 已写入）
    await expect(h.run()).resolves.toBeDefined();
    expect(h.redis.store.has(`${CACHE_KEY.PERMISSION}u-1:v0`), '首次请求应已填充缓存').toBe(true);

    // Act：管理员撤掉 ITEM 权限（改库 + 真实 invalidateSnapshot）
    await h.revoke({ grants: {} });

    // Assert：不重新登录、不换 token、不等 TTL，下一次请求直接 403
    // 注意：JwtStrategy.validate 拿到的 token 参数与上一轮完全相同（同一 sessionId）
    await expectForbidden(h.run());
  });

  it('【核心】撤权生效耗时 < 100ms（证明不是靠 TTL 过期，而是主动失效）', async () => {
    await h.run();
    await h.revoke({ grants: {} });

    const t0 = Date.now();
    const biz = await expectForbidden(h.run());
    const elapsed = Date.now() - t0;

    expect(biz).toBeInstanceOf(BizException);
    expect(elapsed, '若实现靠 sleep / 等 TTL，此处会 > 300000ms 而失败').toBeLessThan(100);
  });

  it('撤权只降「操作」时：READ 被移除 → 403，且拒绝信息里指向功能域与操作', async () => {
    await h.run();
    // 只保留 WRITE，去掉 READ
    await h.revoke({
      grants: {
        [PermissionDomain.ITEM]: {
          domain: PermissionDomain.ITEM,
          ops: ['WRITE'] as OperationType[],
          mode: PermissionMode.LIMITED,
        },
      },
    });

    const biz = await expectForbidden(h.run());
    // 错误文案要能指导排障（PRD「越权拦截需可追溯」的落地）
    expect(biz.message).toContain(PermissionDomain.ITEM);
    expect(biz.message).toContain('READ');
  });

  it('撤权 + 恢复：重新授权后下一次请求立即恢复放行（失效不是单向破坏）', async () => {
    await h.run();
    await h.revoke({ grants: {} });
    await expectForbidden(h.run());

    // 管理员重新授权
    await h.revoke({ grants: archivistsGrants() });
    await expect(h.run(), '重新授权后必须立即恢复，不能等到缓存过期').resolves.toBeDefined();
  });

  it('降密级：SECRET → PUBLIC 后，请求 SECRET 密级资源被 Guard 拦截', async () => {
    // ⚠️ 必须选一个 `checkScope: true` 的接口。Guard 在 `checkScope === false` 时
    // 会 **提前 return true**，密级与数据范围整段跳过（源码 permission.guard.ts:67）。
    // 我第一次用的是 `listItems`（checkScope:false），降密级后依然放行 ——
    // 那不是缺陷，是接口本就不做入口级密级校验（行级过滤由 AccessFilterBuilder 负责）。
    // 这里改用 `itemDetail`（checkScope:true）。
    const handler = ArchiveController.prototype.itemDetail as never;

    // 一条显式带密级的请求（body.securityLevel 由 Guard 提取）
    const request = {
      method: 'POST',
      originalUrl: '/api/archive/items/xxx',
      headers: {},
      body: { securityLevel: SecurityLevel.SECRET },
      query: {},
      params: { id: 'xxx' },
    } as Record<string, unknown>;

    const user = (await h.jwt.validate({
      sub: 'u-1',
      username: 'zhangsan',
      sessionId: 'sid-1',
      type: 'access',
    })) as AuthenticatedUser;
    request[CTX_KEY.USER] = user;

    // 当前 SECRET 上限，允许
    expect(
      h.guard.canActivate(h.ctxOf(handler, request)),
      'SECRET 用户访问 SECRET 资源应放行',
    ).toBe(true);

    // 降到 PUBLIC 后，同一请求被拒
    await h.revoke({ maxSecurityLevel: SecurityLevel.PUBLIC });
    const refreshed = (await h.jwt.validate({
      sub: 'u-1',
      username: 'zhangsan',
      sessionId: 'sid-1',
      type: 'access',
    })) as AuthenticatedUser;
    request[CTX_KEY.USER] = refreshed;

    let caught: unknown = null;
    try {
      h.guard.canActivate(h.ctxOf(handler, request));
    } catch (err) {
      caught = err;
    }
    expect(caught, '降密级后仍放行 = 密级校验没读到最新快照').toBeInstanceOf(BizException);
    expect((caught as BizException).code).toBe(ErrorCode.FORBIDDEN.code);
    expect((caught as BizException).message, '应提示密级不足').toContain('密级');
  });

  it('撤权不影响其他用户：另一个用户的下一次请求照常放行（失效范围精确）', async () => {
    // 同一条链路，但把「库中用户行」换成 u-2 —— 复用同一套 service/guard，
    // 只改 userRow.id。若直接改 id 而不改 live.snapshot，buildSnapshot 会用 u-1 的权限，
    // 造成「u-2 也被撤权」的假象（我第一次写时就犯了这个错）。
    const other = makeChain();
    other.userRow.id = 'u-2';
    other.live.snapshot = snapOf('u-2');
    // jwt 是在 makeChain 内绑定的 userService，需改用 other 自己的 jwt
    const runOther = async () => {
      const cu = (await other.jwt.validate({
        sub: 'u-2',
        username: 'lisi',
        sessionId: 'sid-2',
        type: 'access',
      })) as AuthenticatedUser;
      const req = {
        method: 'GET',
        originalUrl: '/api/archive/items',
        headers: {},
        body: {},
        query: {},
        params: {},
        [CTX_KEY.USER]: cu,
      } as Record<string, unknown>;
      other.guard.canActivate(other.ctxOf(ArchiveController.prototype.listItems as never, req));
      return cu;
    };

    await h.run();
    await runOther();
    await h.revoke({ grants: {} });

    await expectForbidden(h.run());
    await expect(runOther(), 'u-2 未被撤权，必须照常放行').resolves.toBeDefined();
  });
});

// ============================================================================
// 已知边界（如实记录，不作为达标依据）
// ============================================================================
describe('边界说明｜本文件覆盖不到的部分', () => {
  it('本用例未覆盖「多实例」语义：单进程共享 FakeRedis ≠ 多副本广播', () => {
    // 这是一条「文档化断言」，防止后来者把本文件的绿当成 C-5 达标。
    // 真正的多实例用例在 user.permission-revoke-effect.spec.ts 中仍是 skip，
    // 待 E 包（版本号 + perm:invalidate 双通道）实装后启用。
    expect('single-instance-only').toBe('single-instance-only');
  });
});
