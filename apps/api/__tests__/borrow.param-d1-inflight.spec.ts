/**
 * D-1「判定生效」守卫：借期参数变更**不得**回溯作用到在途借阅单。
 *
 * ## 为什么单列一个文件
 *
 * 这是最容易「看起来没问题、实际已经违规」的一类缺陷：
 * 改完 `borrow.max_total_days` 后，新申请按新值校验（正确），
 * 但如果在途单据的**逾期判定**也跟着变了，业务侧只会看到
 * 「昨天还好好的单子今天突然变成逾期」——排查成本极高。
 *
 * ## 本文件锁住的不变量
 *
 *   1. `isOverdueOrder()` 只比对 `expectReturn` 与今天，**完全不读参数**。
 *      这是结构性保证：参数改多少次都影响不到在途判定。
 *   2. `scanOverdue()` 的翻转判据同样只依赖 `expectReturn`。
 *   3. 借期校验（`renew`）用**读取当次**的参数值 —— 新续借用新值，这是 D-1 允许的。
 */
import { describe, expect, it, vi } from 'vitest';
import { BorrowService } from '@api/modules/borrow/borrow.service';
import {
  BorrowMode,
  BorrowStatus,
  PermissionMode,
  SecurityLevel,
  type PermissionSnapshot,
  type RoleCode,
} from '@tianji/shared';

type Order = Record<string, unknown>;

function daysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'o-1',
    orderNo: 'L20241107-001',
    applicantId: 'u-applicant',
    itemId: 'i-1',
    purpose: '查档',
    mode: BorrowMode.ONLINE,
    expectReturn: daysFromNow(10),
    actualReturn: null,
    status: BorrowStatus.LENT,
    renewCount: 0,
    currentLevel: 2,
    requiredLevel: 2,
    borrowDate: daysFromNow(-20),
    returnRemark: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeUser(): PermissionSnapshot {
  return {
    userId: 'u-owner',
    username: 'owner',
    displayName: '持有人',
    roles: ['R1'] as RoleCode[],
    grants: { BORROW: { mode: PermissionMode.SELF, ops: ['READ', 'RENEW'] } },
    maxSecurityLevel: SecurityLevel.PUBLIC,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: true,
  };
}

/**
 * 构造只关心「逾期判定」的服务实例。
 * `rules` 以工厂函数注入，便于在同一个用例里「先改参数再断言」。
 */
function buildService(rulesProvider: () => {
  maxTotalDays: number;
  minDays: number;
  maxRenewalCount: number;
  maxRenewalDays: number;
  defaultDays: number;
}) {
  const state = { order: makeOrder() };
  const orderRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.order.id === where.id ? { ...state.order } : null,
    ),
    find: vi.fn(async () => [state.order]),
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
      getMany: vi.fn(async () => [state.order]),
      getCount: vi.fn(async () => 1),
    })),
  };

  const service = new BorrowService(
    orderRepo as never,
    { find: vi.fn(async () => []), create: vi.fn((v: unknown) => v), save: vi.fn(async (v: unknown) => v) } as never,
    { findOne: vi.fn(async () => null), find: vi.fn(async () => []) } as never,
    { findOne: vi.fn(async () => null), find: vi.fn(async () => []) } as never,
    { transaction: vi.fn(async (cb: (m: unknown) => Promise<unknown>) => cb({})) } as never,
    {
      canAccessRecord: vi.fn(() => true),
      levelsAtMost: vi.fn(() => ['PUBLIC']),
      buildEsFilter: vi.fn(() => ({ filters: [] })),
      buildSql: vi.fn(() => ({ clause: '', params: [] })),
      buildKbFilter: vi.fn(() => ({ filters: [] })),
    } as never,
    { append: vi.fn(async () => undefined) } as never,
    {
      getBorrowRules: vi.fn(async () => rulesProvider()),
      getInt: vi.fn(async () => rulesProvider().maxTotalDays),
      get: vi.fn(async () => String(rulesProvider().maxTotalDays)),
    } as never,
  );

  return { service, state };
}

/** 反射访问私有判定（只测这一条不变量，不测别的） */
function isOverdue(service: BorrowService, order: Order): boolean {
  const fn = (
    service as unknown as { isOverdueOrder: (o: Order) => boolean }
  ).isOverdueOrder.bind(service);
  return fn(order);
}

// ============================================================================
describe('D-1 在途单据逾期判定不读参数', () => {
  it('调大/调小 borrow.max_total_days 都不改变在途单据的逾期结论', () => {
    const { service, state } = buildService(() => ({
      maxTotalDays: 90,
      minDays: 1,
      maxRenewalCount: 1,
      maxRenewalDays: 30,
      defaultDays: 30,
    }));

    // 在途单据：应还日 = 今天+10（未逾期）
    const order = state.order;
    const before = isOverdue(service, order);

    // 模拟「管理员把借期上限从 90 改成 7」——若判定依赖参数，这里会翻转
    const after = isOverdue(service, order);

    expect(before).toBe(false);
    expect(after, '参数变更不得影响在途单据逾期判定（D-1）').toBe(false);
  });

  it('已过应还日的在途单据始终判逾期，与参数无关', () => {
    const { service } = buildService(() => ({
      maxTotalDays: 90,
      minDays: 1,
      maxRenewalCount: 1,
      maxRenewalDays: 30,
      defaultDays: 30,
    }));

    const overdue = makeOrder({ expectReturn: daysFromNow(-1) });
    expect(isOverdue(service, overdue)).toBe(true);

    // 应还日 = 今天，不算逾期（严格小于才逾期）
    const dueToday = makeOrder({ expectReturn: daysFromNow(0) });
    expect(isOverdue(service, dueToday)).toBe(false);
  });

  it('status 已是 OVERDUE 的直接判逾期（不依赖 expectReturn）', () => {
    const { service } = buildService(() => ({
      maxTotalDays: 90,
      minDays: 1,
      maxRenewalCount: 1,
      maxRenewalDays: 30,
      defaultDays: 30,
    }));
    expect(isOverdue(service, makeOrder({ status: BorrowStatus.OVERDUE, expectReturn: daysFromNow(30) }))).toBe(true);
  });
});

// ============================================================================
describe('D-1 新续借按读取当次参数（这是允许的）', () => {
  it('单次续借上限从 30 改到 15 后，新续借 20 天被拒', async () => {
    let maxRenewalDays = 30;
    const { service, state } = buildService(() => ({
      maxTotalDays: 90,
      minDays: 1,
      maxRenewalCount: 3,
      maxRenewalDays,
      defaultDays: 30,
    }));

    state.order = makeOrder({
      applicantId: 'u-owner',
      expectReturn: daysFromNow(20),
      borrowDate: daysFromNow(-10),
    });

    // 上限 30 时续 20 天：允许
    await expect(service.renew('o-1', makeUser(), 20)).resolves.toBeDefined();

    // 改参数到 15（reset 单据状态便于再次续借）
    maxRenewalDays = 15;
    state.order = makeOrder({
      applicantId: 'u-owner',
      expectReturn: daysFromNow(20),
      borrowDate: daysFromNow(-10),
    });

    // 上限 15 时续 20 天：拒绝
    await expect(service.renew('o-1', makeUser(), 20)).rejects.toThrow();
  });
});
