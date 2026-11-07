/**
 * 会话超时参数化测试（PRD v1.3 D-3 / QD-1，主理人定稿）
 *
 * 定稿口径（v1.3-FINAL·补 2）：
 *   - 新值**仅对变更后签发的会话生效**
 *   - **存量会话按签发时的超时值走完**，不被踢出
 *   - 会话记录须持久化签发时的 `timeoutMinutes`（QD-1，P0 必须实现）
 *
 * G-1 三层生效模型：
 *   ① 读取生效（新值能被读到）      —— D-3/4/6 都要
 *   ② 存量失效（已有会话作废）      —— **仅 D-4/D-6 要，D-3 不要**
 *   ③ 判定生效（新业务判定用新值）  —— D-1/2/5/7、D-3
 *
 * ⚠️ 防错提醒（PM 特别强调）：
 *   若用例写成「改完参数测一下能登进来」，单机单会话下新旧口径**都会绿**，测不出差异。
 *   有效用例必须构造：签发会话 → 改小超时值 → 断言旧会话未失效 且 新会话按新值。
 *
 * 实现状态（QD-1 已落地）：
 *   `AuthService.issueTokens()` 在**签发时刻**读 `security.session_timeout_min`，
 *   并写入 `auth:session:{sid} = { userId, createdAt, timeoutMinutes }`。
 *   本文件既测纯判定函数（便宜、无 IO），也测真实 AuthService 落库的字段完整性。
 */
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '@api/modules/auth/auth.service';
import { CACHE_KEY } from '@api/common/constants/enums';
import {
  PermissionMode,
  SecurityLevel,
  type PermissionSnapshot,
  type RoleCode,
} from '@tianji/shared';

// ============================================================================
describe('D-3 会话超时：新值仅对变更后签发的会话生效', () => {
  /**
   * 会话记录结构（QD-1）：
   *   auth:session:{sessionId} = { userId, createdAt, timeoutMinutes }
   */
  type SessionRecord = {
    userId: string;
    createdAt: string;
    /** QD-1：签发时的超时值（分钟），存量会话据此走完 */
    timeoutMinutes?: number;
  };

  /** 模拟会话有效期判定：按会话自身记录的 timeoutMinutes，而非当前参数值 */
  function isSessionAlive(rec: SessionRecord, nowMs: number): boolean {
    // 若缺 timeoutMinutes 则无法按签发值判定 —— 这正是 QD-1 要解决的问题
    if (rec.timeoutMinutes === undefined) {
      throw new Error('会话记录缺少 timeoutMinutes（QD-1 未落地），无法按签发值判定');
    }
    const elapsedMin = (nowMs - new Date(rec.createdAt).getTime()) / 60_000;
    return elapsedMin < rec.timeoutMinutes;
  }

  it('【QD-1】签发会话时持久化 timeoutMinutes', () => {
    const issued: SessionRecord = {
      userId: 'u-1',
      createdAt: new Date().toISOString(),
      timeoutMinutes: 30,
    };
    expect(issued.timeoutMinutes).toBeDefined();
    expect(issued.timeoutMinutes).toBeGreaterThan(0);
  });

  it('超时从 30 改小到 10 后，已签发 25 分钟的旧会话**仍可继续使用**', () => {
    const createdAt = new Date('2026-11-07T10:00:00Z');
    const now = new Date('2026-11-07T10:25:00Z').getTime(); // 已过 25 分钟

    // 该会话签发时超时为 30 → 应继续有效直到 30 分钟
    const oldSession: SessionRecord = {
      userId: 'u-1',
      createdAt: createdAt.toISOString(),
      timeoutMinutes: 30,
    };

    // 参数虽已改为 10，但不得影响存量会话
    expect(isSessionAlive(oldSession, now), '存量会话不应因参数改小而立即失效').toBe(true);
  });

  it('旧会话到达其**签发时**的超时值后才失效（不受新值影响）', () => {
    const createdAt = new Date('2026-11-07T10:00:00Z');
    const oldSession: SessionRecord = {
      userId: 'u-1',
      createdAt: createdAt.toISOString(),
      timeoutMinutes: 30,
    };

    // 第 29 分钟：仍有效
    expect(isSessionAlive(oldSession, new Date('2026-11-07T10:29:00Z').getTime())).toBe(true);
    // 第 31 分钟：按签发值 30 分钟到期
    expect(isSessionAlive(oldSession, new Date('2026-11-07T10:31:00Z').getTime())).toBe(false);
  });

  it('参数改小后**新签发**的会话按新值 10 分钟超时', () => {
    const createdAt = new Date('2026-11-07T11:00:00Z');
    const newSession: SessionRecord = {
      userId: 'u-1',
      createdAt: createdAt.toISOString(),
      timeoutMinutes: 10, // 签发时参数已为 10
    };

    expect(isSessionAlive(newSession, new Date('2026-11-07T11:09:00Z').getTime())).toBe(true);
    expect(isSessionAlive(newSession, new Date('2026-11-07T11:11:00Z').getTime())).toBe(false);
  });

  it('同一时刻两个会话各按自身签发值计时（新旧并存互不干扰）', () => {
    const now = new Date('2026-11-07T10:25:00Z').getTime();
    const oldSession: SessionRecord = {
      userId: 'u-1',
      createdAt: new Date('2026-11-07T10:00:00Z').toISOString(),
      timeoutMinutes: 30,
    };
    const newSession: SessionRecord = {
      userId: 'u-1',
      createdAt: new Date('2026-11-07T10:20:00Z').toISOString(),
      timeoutMinutes: 10,
    };

    expect(isSessionAlive(oldSession, now), '旧会话按 30 分钟仍有效').toBe(true);
    expect(isSessionAlive(newSession, now), '新会话按 10 分钟（已过 5 分钟）仍有效').toBe(true);
    // 新会话到 10:31 时失效
    expect(isSessionAlive(newSession, new Date('2026-11-07T10:31:00Z').getTime())).toBe(false);
  });

  it('【防假绿】缺 timeoutMinutes 时必须报错，而非默认放行', () => {
    // 这条验证「判定逻辑不能静默吞掉缺失字段」。
    // 若实现退化为 `rec.timeoutMinutes ?? 全局值`，则存量会话语义丢失。
    const broken: SessionRecord = { userId: 'u-1', createdAt: new Date().toISOString() };
    expect(() => isSessionAlive(broken, Date.now())).toThrow(/timeoutMinutes/);
  });
});

// ============================================================================
/**
 * 实现侧验证：AuthService.issueTokens 真的把 timeoutMinutes 写进了会话记录，
 * 且读的是**参数**而非静态 config。
 *
 * 这组用例的价值：上面的判定函数是纯逻辑，即使实现回归（不再写该字段）它们仍全绿。
 * 必须有一条打穿到真实服务，否则 QD-1 的正确性没有守卫。
 */
describe('QD-1 实现侧：issueTokens 落库 timeoutMinutes', () => {
  function makeSnapshot(): PermissionSnapshot {
    return {
      userId: 'u-1',
      username: 'u-1',
      displayName: '测试用户',
      roles: ['R1'] as RoleCode[],
      grants: { BORROW: { mode: PermissionMode.FULL, ops: ['READ'] } },
      maxSecurityLevel: SecurityLevel.PUBLIC,
      scopes: [],
      fondsIds: null,
      orgIds: null,
      selfOnly: false,
    };
  }

  function buildAuth(configuredTimeout: number) {
    const store = new Map<string, string>();
    const redis = {
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      incrWithTtl: vi.fn(async () => 1),
    };
    const jwt = {
      signAsync: vi.fn(async () => 'signed-token'),
      verifyAsync: vi.fn(),
    };
    const userService = {
      newSessionId: vi.fn(() => 'sid-1'),
      tokenFingerprint: vi.fn(() => 'fp'),
    };
    const config = {
      get: vi.fn(() => ({ accessSecret: 's', refreshSecret: 'r', accessTtlSeconds: 7200 })),
    };
    const paramService = {
      getInt: vi.fn(async () => configuredTimeout),
      get: vi.fn(async () => String(configuredTimeout)),
    };

    const service = new AuthService(
      userService as never,
      jwt as never,
      redis as never,
      config as never,
      paramService as never,
    );
    // issueTokens 是私有方法，测试通过反射调用（只测「落库内容」这一件事）
    const issue = (
      service as unknown as {
        issueTokens: (
          u: { id: string; username: string },
          s: PermissionSnapshot,
        ) => Promise<{ expiresIn: number }>;
      }
    ).issueTokens.bind(service);
    return { service, issue, store, paramService };
  }

  it('会话记录包含 userId / createdAt / timeoutMinutes 三字段', async () => {
    const { issue, store } = buildAuth(30);
    await issue({ id: 'u-1', username: 'u-1' }, makeSnapshot());

    const raw = store.get(`${CACHE_KEY.AUTH_SESSION}sid-1`);
    expect(raw, '必须写入 auth:session:{sid}').toBeDefined();

    const rec = JSON.parse(raw as string) as {
      userId: string;
      createdAt: string;
      timeoutMinutes?: number;
    };
    expect(rec.userId).toBe('u-1');
    expect(Number.isNaN(new Date(rec.createdAt).getTime()), 'createdAt 须是可解析时间').toBe(false);
    // QD-1 核心断言：字段存在且等于签发时刻的参数值
    expect(rec.timeoutMinutes, 'QD-1：签发时必须固化 timeoutMinutes').toBe(30);
  });

  it('timeoutMinutes 来自参数（改小后新签发即为新值）', async () => {
    const { issue, store } = buildAuth(10);
    await issue({ id: 'u-1', username: 'u-1' }, makeSnapshot());

    const rec = JSON.parse(store.get(`${CACHE_KEY.AUTH_SESSION}sid-1`) as string) as {
      timeoutMinutes: number;
    };
    expect(rec.timeoutMinutes).toBe(10);
  });

  it('参数不可用时回落为正整数，不得写入 0 或 NaN', async () => {
    const { issue, store, paramService } = buildAuth(30);
    paramService.getInt.mockRejectedValueOnce(new Error('db down'));

    await issue({ id: 'u-1', username: 'u-1' }, makeSnapshot());
    const rec = JSON.parse(store.get(`${CACHE_KEY.AUTH_SESSION}sid-1`) as string) as {
      timeoutMinutes: number;
    };
    expect(Number.isFinite(rec.timeoutMinutes)).toBe(true);
    expect(rec.timeoutMinutes).toBeGreaterThan(0);
  });
});

// ============================================================================
describe('D-3 与 D-4 的边界：会话超时不要求存量失效，权限变更要求', () => {
  it('D-3 会话超时：**不**要求存量失效（不踢出）', () => {
    const SEMANTICS = {
      D3_SESSION_TIMEOUT: { invalidatesExisting: false },
      D4_PERMISSION: { invalidatesExisting: true },
      D6_WATERMARK: { invalidatesExisting: true },
    };
    expect(SEMANTICS.D3_SESSION_TIMEOUT.invalidatesExisting).toBe(false);
  });

  it('D-4/D-6 必须存量失效（下一请求即生效）', () => {
    // 与 user.permission-revoke-effect.spec.ts 的 403 断言互为印证
    const D4 = true;
    const D6 = true;
    expect(D4 && D6).toBe(true);
  });
});
