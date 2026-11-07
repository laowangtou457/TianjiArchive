/**
 * 催还提醒天数参数化测试（PRD v1.3 `borrow.overdue_remind_days`）
 *
 * **状态：已接入（Round 3）** —— 原先 5 条 `it.skip` 占位已全部转为真实用例。
 *
 * 实现要点（`borrow.service.ts`）：
 *   - `dueSoon(days?)`：`days` 缺省 → `readRemindDays()` 读参数；
 *   - `readRemindDays()`：`getInt('borrow.overdue_remind_days')`，
 *     用 `Number.isFinite` 判断而非 `|| 3` —— **0 必须保留为 0**（关闭提醒）；
 *   - `remindDays <= 0` → 直接返回 `[]`，不查库。
 *
 * 本文件的核心不是「参数能读到」，而是这条**因果链**：
 *   参数改 7 → 窗口变 7；参数改 0 → 一条都不提醒；参数缺失 → 回落 3。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BorrowService } from '@api/modules/borrow/borrow.service';
import { BorrowMode, BorrowStatus } from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
/** 相对今天偏移 N 天的 YYYY-MM-DD */
function dayOffset(n: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type Order = Record<string, unknown>;

function makeOrder(no: string, expectReturn: string, over: Partial<Order> = {}): Order {
  return {
    id: `o-${no}`,
    orderNo: no,
    applicantId: 'u-1',
    itemId: 'i-1',
    purpose: '查阅',
    mode: BorrowMode.ONLINE,
    status: BorrowStatus.LENT,
    expectReturn,
    actualReturn: null,
    renewCount: 0,
    currentLevel: 1,
    requiredLevel: 1,
    borrowDate: dayOffset(-10),
    returnRemark: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

interface Harness {
  service: BorrowService;
  orderRepo: Record<string, ReturnType<typeof vi.fn>>;
  params: { value: number | null };
  findSpy: ReturnType<typeof vi.fn>;
}

/**
 * @param paramValue 参数服务返回值；`null` = 参数缺失（getInt 抛错，模拟「库里没这条」）
 */
function makeHarness(rows: Order[], paramValue: number | null): Harness {
  const params = { value: paramValue };

  const findSpy = vi.fn(async () => rows);
  const orderRepo = {
    find: findSpy,
    findOne: vi.fn(async () => null),
    createQueryBuilder: vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      getCount: vi.fn(async () => 0),
      getMany: vi.fn(async () => []),
    })),
  };

  const paramService = {
    getInt: vi.fn(async (key: string) => {
      if (key !== 'borrow.overdue_remind_days') return 0;
      if (params.value === null) throw new Error('param missing');
      return params.value;
    }),
    getBorrowRules: vi.fn(async () => ({
      maxTotalDays: 90,
      minDays: 1,
      maxRenewalCount: 1,
      maxRenewalDays: 30,
      defaultDays: 30,
    })),
  };

  const service = new BorrowService(
    orderRepo as never,
    { find: vi.fn(async () => []), create: vi.fn((v: unknown) => v), save: vi.fn(async (v: unknown) => v) } as never,
    { findOne: vi.fn(async () => null), find: vi.fn(async () => []) } as never,
    { findOne: vi.fn(async () => null), find: vi.fn(async () => []) } as never,
    { transaction: vi.fn() } as never,
    {
      canAccessRecord: vi.fn(() => true),
      levelsAtMost: vi.fn(() => []),
      buildEsFilter: vi.fn(() => ({ filters: [] })),
      buildSql: vi.fn(() => ({ clause: '', params: [] })),
      buildKbFilter: vi.fn(() => ({ filters: [] })),
    } as never,
    { append: vi.fn(async () => undefined) } as never,
    paramService as never,
  );

  return { service, orderRepo, params, findSpy };
}

// ============================================================================
describe('borrow.overdue_remind_days —— 催还提醒窗口参数化（已接入）', () => {
  let h: Harness;

  beforeEach(() => {
    // 三条应还日：+2 天、+5 天、+20 天
    h = makeHarness(
      [
        makeOrder('L-1', dayOffset(2)),
        makeOrder('L-2', dayOffset(5)),
        makeOrder('L-3', dayOffset(20)),
      ],
      3,
    );
  });

  it('参数 = 7 → 命中 +2 与 +5 两条，不命中 +20', async () => {
    h.params.value = 7;
    const list = await h.service.dueSoon();
    expect(list.map((o) => o.orderNo).sort()).toEqual(['L-1', 'L-2']);
  });

  it('参数 = 3（默认）→ 只命中 +2 一条', async () => {
    h.params.value = 3;
    const list = await h.service.dueSoon();
    expect(list.map((o) => o.orderNo)).toEqual(['L-1']);
  });

  it('参数 = 30（区间上限）→ 三条全命中（闭区间）', async () => {
    h.params.value = 30;
    const list = await h.service.dueSoon();
    expect(list).toHaveLength(3);
  });

  it('参数 = 0 → 关闭提醒：返回空且**不查库**', async () => {
    h.params.value = 0;
    const list = await h.service.dueSoon();

    expect(list, '0 值必须一条都不提醒').toEqual([]);
    expect(h.findSpy, '0 值下不应发起查询（省一次全表扫描）').not.toHaveBeenCalled();
  });

  it('参数缺失（读不到）→ 回落默认 3 天，不抛错', async () => {
    h.params.value = null;
    const list = await h.service.dueSoon();
    expect(list.map((o) => o.orderNo), '缺失时按 3 天窗口').toEqual(['L-1']);
  });

  it('调用方显式传 days 时优先于参数（调度器/手工触发场景）', async () => {
    h.params.value = 3;
    const list = await h.service.dueSoon(7);
    expect(list).toHaveLength(2);
  });
});

// ============================================================================
describe('borrow.overdue_remind_days —— 假值陷阱防回归', () => {
  /**
   * 这是本文件最重要的一组。
   * `0` 在 JS 中是 falsy，任何 `raw || fallback` 写法都会把「关闭提醒」
   * 静默变成「提醒 3 天」——管理员看到的是「已关闭」，实际仍在发催还通知。
   *
   * 下面用真实服务验证：只要 `readRemindDays` 用了 `||`，`0` 用例必红。
   */
  it('【核心】真实的 0 必须一路保留到「不提醒」，不能被中途回落成 3', async () => {
    const h = makeHarness([makeOrder('L-1', dayOffset(1))], 0);
    const list = await h.service.dueSoon();
    expect(list, '若实现写成 `n || 3`，+1 天单据会被错误提醒 → 本断言变红').toEqual([]);
  });

  it('对照：错误写法会把 0 变成 3（说明陷阱真实存在）', () => {
    const parseWrong = (raw: number): number => raw || 3;
    const parseRight = (raw: number): number => (Number.isFinite(raw) ? raw : 3);

    expect(parseWrong(0), '`||` 写法把 0 变 3').toBe(3);
    expect(parseRight(0), '`Number.isFinite` 写法保留 0').toBe(0);
  });

  it('边界：负数视为关闭（<=0 一视同仁，不出现「负窗口」查询）', async () => {
    const h = makeHarness([makeOrder('L-1', dayOffset(1))], -1);
    const list = await h.service.dueSoon();
    expect(list).toEqual([]);
    expect(h.findSpy).not.toHaveBeenCalled();
  });
});
