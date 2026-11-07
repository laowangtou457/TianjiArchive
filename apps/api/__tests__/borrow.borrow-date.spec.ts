/**
 * 借出日（borrowDate）字段测试 —— BR-06-3 校验基准日
 *
 * 覆盖工程师新增的 `borrowDate` 能力（迁移 `1700000000002-AddBorrowDate.ts`）：
 *   ① `lend()` 后 `borrowDate` 写入当日（YYYY-MM-DD）
 *   ② 有 borrowDate：按「借出日 → 新应还日」精确校验总借期
 *   ③ 无 borrowDate（历史单据）：退化为弱校验「不得缩短应还日」并打 WARN
 *   ④ borrowDate 脏值：明确报错，不静默放行
 */
import { describe, expect, it, vi } from 'vitest';
import { BorrowService } from '@api/modules/borrow/borrow.service';
import {
  BorrowMode,
  BorrowStatus,
  SecurityLevel,
  type PermissionSnapshot,
} from '@tianji/shared';

const DAY_MS = 86_400_000;

function dateOffset(days: number): string {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

type Order = Record<string, unknown>;

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'o-1',
    orderNo: 'L20241107-001',
    applicantId: 'u-owner',
    itemId: 'i-1',
    purpose: '编写年度报告',
    mode: BorrowMode.ONLINE,
    expectReturn: dateOffset(30),
    actualReturn: null,
    status: BorrowStatus.LENT,
    renewCount: 0,
    currentLevel: 1,
    requiredLevel: 1,
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

function makeHarness(initial: Order) {
  const state = { order: initial };
  const warnings: string[] = [];

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

  const txRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) =>
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

  let chain: Promise<unknown> = Promise.resolve();
  const dataSource = {
    transaction: vi.fn((cb: (m: unknown) => Promise<unknown>) => {
      const run = chain.then(() => cb(manager));
      chain = run.then(
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
        title: '报告',
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

  // 捕获 logger.warn 以断言历史单据告警
  const logger = (service as unknown as { logger: Record<string, unknown> }).logger;
  if (logger && typeof logger.warn === 'function') {
    vi.spyOn(logger as { warn: (m: string) => void }, 'warn').mockImplementation((m: string) => {
      warnings.push(m);
    });
  }

  return { service, state, warnings };
}

// ============================================================================
describe('lend() 写入 borrowDate', () => {
  it('借出后 borrowDate = 当日（YYYY-MM-DD）', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.APPROVED, borrowDate: null }));

    const dto = await h.service.lend('o-1', makeUser({ userId: 'u-approver' }));

    expect(h.state.order.borrowDate).toBe(dateOffset(0));
    expect(dto.status).toBe(BorrowStatus.LENT);
  });

  it('borrowDate 格式为 YYYY-MM-DD（无时间部分）', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.APPROVED, borrowDate: null }));
    await h.service.lend('o-1', makeUser({ userId: 'u-approver' }));
    expect(h.state.order.borrowDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ============================================================================
describe('有 borrowDate：按借出日精确校验总借期（BR-06-3）', () => {
  it('总借期恰好 90 天 → 允许', async () => {
    // 借出日 = 今天-60，应还 = 今天，续 30 → 总 90
    const h = makeHarness(
      makeOrder({ borrowDate: dateOffset(-60), expectReturn: dateOffset(0) }),
    );
    await expect(h.service.renew('o-1', makeUser(), 30)).resolves.toBeTruthy();
    expect(h.state.order.renewCount).toBe(1);
  });

  it('总借期 91 天 → 拒绝', async () => {
    const h = makeHarness(
      makeOrder({ borrowDate: dateOffset(-60), expectReturn: dateOffset(0) }),
    );
    await expect(h.service.renew('o-1', makeUser(), 31)).rejects.toThrow();
    expect(h.state.order.renewCount).toBe(0);
  });

  it('借出日决定基准：同样剩余天数，借出日越早越容易超限', async () => {
    // 场景 A：借出日 今天-10，应还 今天+70，续 10 → 总 90 ✅
    const a = makeHarness(
      makeOrder({ borrowDate: dateOffset(-10), expectReturn: dateOffset(70) }),
    );
    await expect(a.service.renew('o-1', makeUser(), 10)).resolves.toBeTruthy();

    // 场景 B：借出日 今天-20，应还 今天+70，续 10 → 总 100 ✗
    const b = makeHarness(
      makeOrder({ borrowDate: dateOffset(-20), expectReturn: dateOffset(70) }),
    );
    await expect(b.service.renew('o-1', makeUser(), 10)).rejects.toThrow();
  });
});

// ============================================================================
describe('无 borrowDate：历史单据弱校验 + WARN', () => {
  it('无借出日 + 续借延长应还日 → 允许（弱校验放行）', async () => {
    const h = makeHarness(
      makeOrder({ borrowDate: null, expectReturn: dateOffset(20) }),
    );
    await expect(h.service.renew('o-1', makeUser(), 10)).resolves.toBeTruthy();
    // 应还日确实被顺延
    expect(h.state.order.expectReturn).toBe(dateOffset(30));
  });

  it('无借出日时打出「缺少借出日」告警（可观测，便于数据治理）', async () => {
    const h = makeHarness(makeOrder({ borrowDate: null, expectReturn: dateOffset(20) }));
    await h.service.renew('o-1', makeUser(), 10);
    expect(h.warnings.some((w) => w.includes('缺少借出日'))).toBe(true);
  });

  it('无借出日 + 续借天数为 0 → 被入参校验拦截（不会走到弱校验）', async () => {
    const h = makeHarness(makeOrder({ borrowDate: null, expectReturn: dateOffset(20) }));
    await expect(h.service.renew('o-1', makeUser(), 0)).rejects.toThrow();
  });
});

// ============================================================================
describe('borrowDate 脏值处理', () => {
  it('借出日格式非法 → 明确报错，不静默放行', async () => {
    const h = makeHarness(makeOrder({ borrowDate: 'not-a-date', expectReturn: dateOffset(20) }));
    const err = await h.service
      .renew('o-1', makeUser(), 10)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { message?: string }).message).toMatch(/借出日|日期/);
    expect(h.state.order.renewCount).toBe(0);
  });

  it('借出日晚于应还日（数据颠倒）→ 拒绝续借', async () => {
    const h = makeHarness(
      makeOrder({ borrowDate: dateOffset(10), expectReturn: dateOffset(5) }),
    );
    await expect(h.service.renew('o-1', makeUser(), 1)).rejects.toThrow();
  });
});

// ============================================================================
describe('日期算术正确性（借出日基准）', () => {
  function addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  it('跨月末推进按自然日，不按 30 天/月', () => {
    expect(addDays('2024-01-31', 30)).toBe('2024-03-01');
  });

  it('闰年 2 月 28 日 + 1 天 = 2 月 29 日', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('平年 2 月 28 日 + 1 天 = 3 月 1 日', () => {
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
  });

  it('总借期天数为整数天（不受时区/夏令时影响）', () => {
    const start = new Date('2024-03-01T00:00:00Z').getTime();
    const end = new Date('2024-05-30T00:00:00Z').getTime();
    expect(Math.round((end - start) / DAY_MS)).toBe(90);
  });
});
