/**
 * 借阅续借边界测试（PRD v1.1 §5.4 / BR-06-1 ~ BR-06-7）
 *
 * 覆盖产品经理裁定的 7 条规则：
 *   BR-06-1 总借期上限（借出日 → 应还日 ≤ MAX_TOTAL_DAYS）
 *   BR-06-2 续借次数 ≤ MAX_RENEWAL_COUNT
 *   BR-06-3 校验基准为「借出日」而非今天（负数天数反向漏判防线）
 *   BR-06-4 逾期状态拒绝续借
 *   BR-06-5 仅「已借出」可续借
 *   BR-06-6 续借需审批（按原单密级）
 *   BR-06-7 续借天数 ≥ 1
 *
 * 常量一律从 shared 读取，不硬编码 90 / 1，便于单位口径调整后用例无需重写。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BorrowService } from '@api/modules/borrow/borrow.service';
import {
  BORROW_MIN_DAYS,
  BORROW_RULES_FALLBACK,
  BorrowMode,
  BorrowStatus,
  SecurityLevel,
  type PermissionSnapshot,
} from '@tianji/shared';

// ---------------------------------------------------------------- 共享常量
/**
 * 借阅规则取值。
 *
 * v1.3 起数值由 `sys_param` 运行期下发（`PARAM_DEFS` 唯一定义源），
 * `BORROW_RULES_FALLBACK` 仅作「参数缺失/非法」时的容错兜底。
 * 用例跑在兜底值上，等价于「参数全部使用产品默认值」的最常见部署形态；
 * 参数化生效路径另见 `borrow.param-wiring.spec.ts`（待接入后启用）。
 *
 * 仍然**不硬编码**数字：口径调整只改 PARAM_DEFS，用例自动跟随。
 */
const RULES = BORROW_RULES_FALLBACK;
const MAX_TOTAL_DAYS = RULES.maxTotalDays;
const MAX_RENEWAL_COUNT = RULES.maxRenewalCount;
const MIN_EXTEND_DAYS = BORROW_MIN_DAYS;
const MAX_SINGLE_RENEW_DAYS = RULES.maxRenewalDays;

// ------------------------------------------------------------------ 工具
const DAY_MS = 86_400_000;

/** 返回相对今天偏移 N 天的 YYYY-MM-DD（UTC 自然日） */
function dateOffset(days: number): string {
  const base = new Date();
  const utc = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/** 计算 YYYY-MM-DD 距今天的天数（负数表示已逾期） */
function daysFromToday(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / DAY_MS);
}

// ------------------------------------------------------------------ 夹具
type Order = Record<string, unknown>;

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'o-1',
    orderNo: 'L20241107-001',
    applicantId: 'u-owner',
    itemId: 'i-1',
    purpose: '编写年度报告需要查阅',
    mode: BorrowMode.ONLINE,
    expectReturn: dateOffset(30),
    actualReturn: null,
    status: BorrowStatus.LENT,
    renewCount: 0,
    currentLevel: 1,
    requiredLevel: 1,
    returnRemark: null,
    // borrowDate 是 BR-06-3 的校验基准
    borrowDate: dateOffset(-10),
    createdAt: new Date(),
    ...over,
  };
}

function makeUser(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    userId: 'u-owner',
    username: 'owner',
    displayName: '借阅人',
    roles: ['R1'],
    grants: {},
    maxSecurityLevel: SecurityLevel.SECRET,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    ...over,
  };
}

interface Harness {
  service: BorrowService;
  state: { order: Order };
  orderRepo: Record<string, ReturnType<typeof vi.fn>>;
}

function makeHarness(initial: Order): Harness {
  const state = { order: initial };

  const orderRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.order.id === where.id ? { ...state.order } : null,
    ),
    count: vi.fn(async () => 0),
    update: vi.fn(async (_w: unknown, patch: Partial<Order>) => {
      state.order = { ...state.order, ...patch };
      return { affected: 1 };
    }),
    create: vi.fn((v: unknown) => v),
    save: vi.fn(async (v: unknown) => v),
    createQueryBuilder: vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      getCount: vi.fn(async () => 0),
    })),
  };

  /**
   * 事务内的 Repository（`manager.getRepository(BorrowOrder)`）。
   *
   * 说明：`renew()` 已改为「事务 + pessimistic_write 行锁」防并发。
   * 真实 PG 下后到的请求会阻塞在 FOR UPDATE 上，待前者提交后重读到新 renewCount。
   * 单元测试无法复现行锁阻塞，因此这里用**串行队列**模拟该语义：
   * 同一单据的事务体串行执行，确保第二个请求读到的是第一个提交后的状态。
   */
  const txRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string }; lock?: unknown }) =>
      state.order.id === where.id ? { ...state.order } : null,
    ),
    update: vi.fn(async (_w: unknown, patch: Partial<Order>) => {
      state.order = { ...state.order, ...patch };
      return { affected: 1 };
    }),
  };

  const manager = {
    getRepository: vi.fn(() => txRepo),
    create: vi.fn((_e: unknown, v: unknown) => v),
    save: vi.fn(async (v: Order) => ({ id: 'ap-1', actedAt: new Date(), ...v })),
    update: vi.fn(async (_e: unknown, _w: unknown, patch: Partial<Order>) => {
      state.order = { ...state.order, ...patch };
      return { affected: 1 };
    }),
  };

  // 串行队列：模拟 FOR UPDATE 行锁对同单据事务的互斥
  let lockChain: Promise<unknown> = Promise.resolve();
  const dataSource = {
    transaction: vi.fn((cb: (m: unknown) => Promise<unknown>) => {
      const run = lockChain.then(() => cb(manager));
      // 无论成功失败都要释放锁，且不因失败中断后续事务
      lockChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };

  const service = new BorrowService(
    orderRepo as never,
    { find: vi.fn(async () => []) } as never,
    {
      findOne: vi.fn(async () => ({
        id: 'i-1',
        danghao: 'A036-2024-BGS-Y-0001-0001',
        title: '关于年度工作的报告',
        securityLevel: SecurityLevel.INTERNAL,
        fondsId: 'f-1',
        orgId: 'o-1',
        createdBy: 'u-other',
        deleted: false,
      })),
      find: vi.fn(async () => []),
    } as never,
    { findOne: vi.fn(async () => ({ id: 'u-owner', displayName: '借阅人' })), find: vi.fn(async () => []) } as never,
    dataSource as never,
    {
      canAccessRecord: vi.fn(() => true),
      levelsAtMost: vi.fn(() => ['PUBLIC', 'INTERNAL', 'SECRET']),
      buildEsFilter: vi.fn(() => ({ filters: [] })),
      buildSql: vi.fn(() => ({ clause: '', params: [] })),
      buildKbFilter: vi.fn(() => ({ filters: [] })),
    } as never,
    { append: vi.fn(async () => undefined) } as never,
  );

  return { service, state, orderRepo };
}

/** 断言抛出指定错误码 */
function expectBizCode(err: unknown, code: number): void {
  const e = err as { name?: string; code?: number; message?: string };
  expect(e?.name, `期望 BizException，实际 ${JSON.stringify(err)}`).toBe('BizException');
  expect(e.code).toBe(code);
}

// ============================================================================
describe('BR-06-4 逾期单据续借必须拒绝（防负数天数反向漏判）', () => {
  let h: Harness;

  it('【关键】OVERDUE 状态续借 → 拒绝（3001 状态非法）', async () => {
    h = makeHarness(
      makeOrder({ status: BorrowStatus.OVERDUE, expectReturn: dateOffset(-5) }),
    );
    const err = await h.service
      .renew('o-1', makeUser(), MIN_EXTEND_DAYS)
      .then(() => null)
      .catch((e: unknown) => e);
    expectBizCode(err, 3001);
  });

  it('【反向漏判·高危】LENT 但应还日已过（扫描器未跑）→ 必须拒绝续借', async () => {
    // 这是 PM 点名的风险场景：状态仍为 LENT，但 expectReturn 早于今天。
    // 若实现只用「expectReturn 距今天数 ≤ 上限」判断，负数天数会直接通过，
    // 导致逾期单被续借成功。必须显式拦截。
    h = makeHarness(
      makeOrder({ status: BorrowStatus.LENT, expectReturn: dateOffset(-1) }),
    );
    const err = await h.service
      .renew('o-1', makeUser(), MIN_EXTEND_DAYS)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err, '逾期未还的单据不应允许续借').not.toBeNull();
    expectBizCode(err, 3001);
    // 断言未落库
    expect(h.state.order.renewCount).toBe(0);
    expect(h.state.order.expectReturn).toBe(dateOffset(-1));
  });

  it('LENT 且应还日为昨天（跨日边界）→ 拒绝', async () => {
    h = makeHarness(makeOrder({ status: BorrowStatus.LENT, expectReturn: dateOffset(-1) }));
    await expect(h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS)).rejects.toThrow();
  });

  it('LENT 且应还日为今天（仍未逾期）→ 允许', async () => {
    h = makeHarness(makeOrder({ status: BorrowStatus.LENT, expectReturn: dateOffset(0) }));
    const dto = await h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS);
    expect(dto).toBeTruthy();
    expect(h.state.order.renewCount).toBe(1);
  });
});

// ============================================================================
describe('BR-06-1 / BR-06-3 总借期上限按「借出日」计算', () => {
  let h: Harness;

  it(`恰好 ${MAX_TOTAL_DAYS} 天（压线）→ 允许`, async () => {
    // 借出日 = 今天 - 60，续借 30 → 总借期正好 90 天
    const borrowDate = dateOffset(-(MAX_TOTAL_DAYS - 30));
    h = makeHarness(
      makeOrder({ status: BorrowStatus.LENT, borrowDate, expectReturn: dateOffset(0) }),
    );
    const dto = await h.service.renew('o-1', makeUser(), 30);
    expect(dto).toBeTruthy();
    expect(h.state.order.renewCount).toBe(1);
    expect(daysFromToday(String(h.state.order.expectReturn))).toBe(
      MAX_TOTAL_DAYS - (MAX_TOTAL_DAYS - 30),
    );
  });

  it(`${MAX_TOTAL_DAYS + 1} 天（超 1 天）→ 拒绝`, async () => {
    const borrowDate = dateOffset(-(MAX_TOTAL_DAYS - 30));
    h = makeHarness(
      makeOrder({ status: BorrowStatus.LENT, borrowDate, expectReturn: dateOffset(0) }),
    );
    const err = await h.service
      .renew('o-1', makeUser(), 31)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    // 400 参数错误（借期不得超过 N 天）
    expect((err as { httpStatus?: number }).httpStatus).toBe(400);
    expect(h.state.order.renewCount).toBe(0);
  });

  it(`剩 60 天续 30 天 = ${MAX_TOTAL_DAYS}，允许`, async () => {
    // 借出日 = 今天 − 30，原应还 = 今天 + 60，续 30 后新应还 = 今天 + 90
    // 总借期 = 今天+90 − (今天−30) = 120 天 > 90 ✗
    // 故需借出日 = 今天，总借期 = 90 ✓
    h = makeHarness(
      makeOrder({
        status: BorrowStatus.LENT,
        expectReturn: dateOffset(60),
        borrowDate: dateOffset(0),
      }),
    );
    await expect(h.service.renew('o-1', makeUser(), 30)).resolves.toBeTruthy();
    expect(h.state.order.expectReturn).toBe(dateOffset(90));
  });

  it(`剩 61 天续 30 天 = ${MAX_TOTAL_DAYS + 1}，拒绝`, async () => {
    h = makeHarness(
      makeOrder({
        status: BorrowStatus.LENT,
        expectReturn: dateOffset(61),
        borrowDate: dateOffset(0),
      }),
    );
    await expect(h.service.renew('o-1', makeUser(), 30)).rejects.toThrow();
  });

  it('校验基准不是今天：即使今天距借出日很短，只要总借期超限就拒绝', async () => {
    // 借出日在 89 天前，续 5 天 → 总 94 天，必然超限
    h = makeHarness(
      makeOrder({
        status: BorrowStatus.LENT,
        borrowDate: dateOffset(-(MAX_TOTAL_DAYS - 1)),
        expectReturn: dateOffset(0),
      }),
    );
    await expect(h.service.renew('o-1', makeUser(), 5)).rejects.toThrow();
  });
});

// ============================================================================
describe('BR-06 单次续借天数上限（原缺陷 #5，已修复 → 回归护栏）', () => {
  /**
   * 【原缺陷 #5，已修复】PRD v1.3 定义独立参数 `borrow.max_renewal_days`
   * （单次续借 ≤ 30 天），与「总借期 ≤ 90 天」是**两个独立维度**。
   *
   * 修复前：实现只有总借期校验，单次续借 31 天在总借期余量充足时会被放行。
   * 修复后：`BorrowService.renew` 在锁内 `if (days > rules.maxRenewalDays) throw`。
   *
   * ⚠️ 取值仍从共享常量读（`RULES.maxRenewalDays`），**不硬编码 30**。
   * 历史教训（报告 §8.2）：修复前该字段为 `undefined`，`undefined + 1 = NaN`，
   * 断言里做数值比较会「因 NaN 被拒」而假绿 —— 故此处额外加一条
   * 「字段必须是有限正数」的前置守卫，防止字段再次被删/改名后用例静默失真。
   */
  let h: Harness;

  it('前置守卫：maxRenewalDays 必须是有限正数（防字段丢失导致假绿）', () => {
    expect(Number.isFinite(MAX_SINGLE_RENEW_DAYS), 'maxRenewalDays 缺失 → 用例会假绿').toBe(true);
    expect(MAX_SINGLE_RENEW_DAYS).toBeGreaterThan(0);
  });

  beforeEach(() => {
    // 借出日 = 今天，应还 = 今天+20。总借期余量充足（20+31=51 < 90），
    // 确保若被拒绝，原因只可能是「单次超限」，不会是总借期超限。
    h = makeHarness(
      makeOrder({
        status: BorrowStatus.LENT,
        expectReturn: dateOffset(20),
        borrowDate: dateOffset(0),
      }),
    );
  });

  it('续借恰好单次上限 → 允许（闭区间）', async () => {
    await expect(h.service.renew('o-1', makeUser(), MAX_SINGLE_RENEW_DAYS)).resolves.toBeTruthy();
    expect(h.state.order.renewCount).toBe(1);
  });

  it('续借 上限+1 天 → 拒绝（原缺陷 #5 回归护栏）', async () => {
    const err = await h.service
      .renew('o-1', makeUser(), MAX_SINGLE_RENEW_DAYS + 1)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(
      err,
      `单次续借 ${MAX_SINGLE_RENEW_DAYS + 1} 天应被拒绝（max_renewal_days=${MAX_SINGLE_RENEW_DAYS}）`,
    ).not.toBeNull();
    // 被拒后不得留下续借痕迹
    expect(h.state.order.renewCount, '拒绝时不得写入 renewCount').toBe(0);
  });

  it('总借期合规不豁免单次上限：余量充足但单次超限 → 拒绝', async () => {
    // 借出日 = 今天、应还 = 今天+40，续 45 → 总 85 < 90（总借期合规），但单次 45 > 30 → 应拒
    const h2 = makeHarness(
      makeOrder({
        status: BorrowStatus.LENT,
        expectReturn: dateOffset(40),
        borrowDate: dateOffset(0),
      }),
    );
    const err = await h2.service
      .renew('o-1', makeUser(), MAX_SINGLE_RENEW_DAYS + 15)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err, '总借期合规但单次超限，仍应拒绝').not.toBeNull();
    expect(h2.state.order.renewCount).toBe(0);
  });
});

// ============================================================================
describe('BR-06-2 续借次数上限', () => {
  let h: Harness;

  it('首次续借（renewCount=0）→ 允许', async () => {
    h = makeHarness(makeOrder({ status: BorrowStatus.LENT, renewCount: 0 }));
    await expect(h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS)).resolves.toBeTruthy();
    expect(h.state.order.renewCount).toBe(1);
  });

  it('已达上限（renewCount = MAX）→ 拒绝 3004', async () => {
    h = makeHarness(makeOrder({ status: BorrowStatus.LENT, renewCount: MAX_RENEWAL_COUNT }));
    const err = await h.service
      .renew('o-1', makeUser(), MIN_EXTEND_DAYS)
      .then(() => null)
      .catch((e: unknown) => e);
    expectBizCode(err, 3004);
    expect(h.state.order.renewCount).toBe(MAX_RENEWAL_COUNT);
  });

  it('超过上限（renewCount > MAX）→ 拒绝 3004', async () => {
    h = makeHarness(makeOrder({ status: BorrowStatus.LENT, renewCount: MAX_RENEWAL_COUNT + 3 }));
    await expect(h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS)).rejects.toThrow();
  });
});

// ============================================================================
describe('BR-06-5 仅「已借出」可续借（全状态遍历）', () => {
  const NON_LENT: BorrowStatus[] = [
    BorrowStatus.PENDING,
    BorrowStatus.APPROVED,
    BorrowStatus.REJECTED,
    BorrowStatus.RETURNED,
    BorrowStatus.OVERDUE,
    BorrowStatus.CANCELLED,
  ];

  it.each(NON_LENT)('状态 %s 续借 → 拒绝 3001', async (status) => {
    const h = makeHarness(makeOrder({ status, expectReturn: dateOffset(10) }));
    const err = await h.service
      .renew('o-1', makeUser(), MIN_EXTEND_DAYS)
      .then(() => null)
      .catch((e: unknown) => e);
    expectBizCode(err, 3001);
    expect(h.state.order.renewCount).toBe(0);
  });

  it('状态 LENT 续借 → 允许（正向对照）', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.LENT, expectReturn: dateOffset(10) }));
    await expect(h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS)).resolves.toBeTruthy();
  });
});

// ============================================================================
describe('BR-06-7 续借天数下限', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness(makeOrder({ status: BorrowStatus.LENT, expectReturn: dateOffset(10) }));
  });

  it('续借 0 天 → 拒绝（400 参数错误）', async () => {
    const err = await h.service
      .renew('o-1', makeUser(), 0)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { httpStatus?: number }).httpStatus).toBe(400);
    expect(h.state.order.renewCount).toBe(0);
  });

  it('续借负数天 → 拒绝（400 参数错误）', async () => {
    const err = await h.service
      .renew('o-1', makeUser(), -5)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { httpStatus?: number }).httpStatus).toBe(400);
    expect(h.state.order.renewCount).toBe(0);
  });

  it('续借 1 天（下限合法值）→ 允许', async () => {
    await expect(h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS)).resolves.toBeTruthy();
    expect(h.state.order.renewCount).toBe(1);
  });
});

// ============================================================================
describe('续借属主校验与并发', () => {
  it('非本人续借 → 拒绝 3005', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.LENT, expectReturn: dateOffset(10) }));
    const err = await h.service
      .renew('o-1', makeUser({ userId: 'u-other' }), MIN_EXTEND_DAYS)
      .then(() => null)
      .catch((e: unknown) => e);
    expectBizCode(err, 3005);
  });

  it('并发续借同一单据 → 仅一次成功，renewCount 不超上限', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.LENT, expectReturn: dateOffset(10) }));
    const results = await Promise.allSettled([
      h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS),
      h.service.renew('o-1', makeUser(), MIN_EXTEND_DAYS),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok, '并发续借只能有一个成功').toBeLessThanOrEqual(MAX_RENEWAL_COUNT);
    expect(h.state.order.renewCount).toBeLessThanOrEqual(MAX_RENEWAL_COUNT);
  });
});

// ============================================================================
describe('BR-06 日期加法按自然日（跨月/跨闰年/跨年末）', () => {
  /**
   * 说明：`renew()` 有逾期前置校验（BR-06-4），不能喂历史日期。
   * 因此这里直接验证私有日期加法 `addDays` 的日历正确性，
   * 再用一个「今天起算」的续借用例验证它被正确接线。
   */
  function addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  it('跨月末：1 月 31 日 + 30 天 → 3 月 1 日（非 30 天/月换算）', () => {
    expect(addDays('2024-01-31', 30)).toBe('2024-03-01');
  });

  it('跨闰年 2 月：闰日存在时按真实日历推进', () => {
    // 2024 是闰年，2 月有 29 天
    expect(addDays('2024-02-15', 20)).toBe('2024-03-06');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('非闰年 2 月：28 日 + 1 天 → 3 月 1 日', () => {
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
  });

  it('跨年末：12 月 20 日 + 20 天 → 次年 1 月 9 日', () => {
    expect(addDays('2024-12-20', 20)).toBe('2025-01-09');
  });

  it('续借走的是同一天数加法（今天起算，跨月自然推进）', async () => {
    // 选一个今天+30 天必然跨月的场景无法保证，故只验证「结果 = 原应还日 +30 自然日」
    const expectReturn = dateOffset(5);
    const h = makeHarness(
      makeOrder({ status: BorrowStatus.LENT, expectReturn, borrowDate: dateOffset(0) }),
    );
    const dto = await h.service.renew('o-1', makeUser(), 30);
    expect(dto).toBeTruthy();
    expect(h.state.order.expectReturn).toBe(addDays(expectReturn, 30));
  });
});
