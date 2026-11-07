/**
 * 借阅状态机单元测试（apps/api/src/modules/borrow/borrow.service.ts + shared 流转表）
 *
 * 覆盖：7 状态合法/非法迁移、禁止自审、SECRET 双级审批、意见必填、
 *       撤销仅限本人、续借上限、逾期后禁止再借、借期边界（1~90 天）。
 *
 * 说明：Repository / DataSource / AuditLogService 全部 mock，不依赖 PG。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BorrowService } from '@api/modules/borrow/borrow.service';
import {
  ApprovalAction,
  BORROW_TRANSITIONS,
  BorrowMode,
  BorrowStatus,
  isBorrowTerminal,
  SecurityLevel,
  type PermissionSnapshot,
} from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
type Order = Record<string, unknown>;

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'o-1',
    orderNo: 'L20241107-001',
    applicantId: 'u-applicant',
    itemId: 'i-1',
    purpose: '编写年度报告需要查阅',
    mode: BorrowMode.ONLINE,
    expectReturn: '2099-12-31',
    actualReturn: null,
    status: BorrowStatus.PENDING,
    renewCount: 0,
    currentLevel: 1,
    requiredLevel: 1,
    returnRemark: null,
    createdAt: new Date('2024-11-07T00:00:00Z'),
    ...over,
  };
}

function makeUser(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    userId: 'u-approver',
    username: 'approver',
    displayName: '审批人',
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
  orderRepo: Record<string, ReturnType<typeof vi.fn>>;
  approvalRepo: Record<string, ReturnType<typeof vi.fn>>;
  itemRepo: Record<string, ReturnType<typeof vi.fn>>;
  userRepo: Record<string, ReturnType<typeof vi.fn>>;
  manager: Record<string, ReturnType<typeof vi.fn>>;
  auditLog: { append: ReturnType<typeof vi.fn> };
  state: { order: Order; approvals: Order[] };
}

function makeHarness(initial: Order = makeOrder()): Harness {
  const state = { order: initial, approvals: [] as Order[] };

  const orderRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.order.id === where.id ? { ...state.order } : null,
    ),
    count: vi.fn(async () => 0),
    update: vi.fn(async (_where: unknown, patch: Partial<Order>) => {
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

  // 审批留痕仓储。approve() 现在在锁内用 approvalRepo.create + save 写入，
  // 与 manager.save 的分工保持双份（真实代码两处都可能落库），夹具两者都实现。
  const approvalRepo = {
    find: vi.fn(async () => state.approvals),
    create: vi.fn((v: unknown) => v),
    save: vi.fn(async (v: Order) => {
      const persisted = { id: `ap-${state.approvals.length + 1}`, actedAt: new Date(), ...v };
      state.approvals.push(persisted);
      return persisted;
    }),
  };

  const itemRepo = {
    findOne: vi.fn(async () => ({
      id: 'i-1',
      danghao: 'A036-2024-BGS-Y-0001-0001',
      title: '关于年度工作的报告',
      securityLevel: SecurityLevel.SECRET,
      fondsId: 'f-1',
      orgId: 'o-1',
      createdBy: 'u-other',
      deleted: false,
    })),
    find: vi.fn(async () => []),
  };

  const userRepo = {
    findOne: vi.fn(async () => ({ id: 'u-applicant', displayName: '申请人', username: 'app' })),
    find: vi.fn(async () => []),
  };

  const manager = {
    // renew() 已改为「事务 + pessimistic_write 行锁」，事务内经 getRepository 取仓储。
    // 这里复用 orderRepo 的读写语义即可（单元测试不模拟真实行锁阻塞）。
    getRepository: vi.fn(() => orderRepo),
    create: vi.fn((_e: unknown, v: unknown) => v),
    save: vi.fn(async (v: Order) => {
      // 与实体/迁移一致：acted_at 由数据库 DEFAULT now() 填充，返回已落库的实体
      const persisted = {
        id: `ap-${state.approvals.length + 1}`,
        actedAt: new Date(),
        ...v,
      };
      state.approvals.push(persisted);
      return persisted;
    }),
    update: vi.fn(async (_e: unknown, _w: unknown, patch: Partial<Order>) => {
      state.order = { ...state.order, ...patch };
      return { affected: 1 };
    }),
  };

  const dataSource = {
    transaction: vi.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };

  const accessBuilder = {
    canAccessRecord: vi.fn(() => true),
    levelsAtMost: vi.fn(() => ['PUBLIC', 'INTERNAL', 'SECRET']),
    buildEsFilter: vi.fn(() => ({ filters: [] })),
    buildSql: vi.fn(() => ({ clause: '', params: [] })),
    buildKbFilter: vi.fn(() => ({ filters: [] })),
  };

  const auditLog = { append: vi.fn(async () => undefined) };

  const service = new BorrowService(
    orderRepo as never,
    approvalRepo as never,
    itemRepo as never,
    userRepo as never,
    dataSource as never,
    accessBuilder as never,
    auditLog as never,
  );

  return { service, orderRepo, approvalRepo, itemRepo, userRepo, manager, auditLog, state };
}

// ============================================================================
describe('BORROW_TRANSITIONS 流转表完整性（7 状态）', () => {
  const ALL: BorrowStatus[] = [
    'PENDING',
    'APPROVED',
    'REJECTED',
    'LENT',
    'RETURNED',
    'OVERDUE',
    'CANCELLED',
  ];

  it('每个状态都在流转表中声明', () => {
    for (const s of ALL) expect(BORROW_TRANSITIONS[s]).toBeDefined();
  });

  it('主链路 PENDING→APPROVED→LENT→RETURNED 全部可达', () => {
    expect(BORROW_TRANSITIONS.PENDING).toContain('APPROVED');
    expect(BORROW_TRANSITIONS.APPROVED).toContain('LENT');
    expect(BORROW_TRANSITIONS.LENT).toContain('RETURNED');
  });

  it('支线 REJECTED / CANCELLED / OVERDUE 可达', () => {
    expect(BORROW_TRANSITIONS.PENDING).toContain('REJECTED');
    expect(BORROW_TRANSITIONS.PENDING).toContain('CANCELLED');
    expect(BORROW_TRANSITIONS.LENT).toContain('OVERDUE');
    expect(BORROW_TRANSITIONS.OVERDUE).toContain('RETURNED');
  });

  it('终态不能再流转（REJECTED / RETURNED / CANCELLED）', () => {
    for (const s of ['REJECTED', 'RETURNED', 'CANCELLED'] as BorrowStatus[]) {
      expect(BORROW_TRANSITIONS[s]).toEqual([]);
      expect(isBorrowTerminal(s)).toBe(true);
    }
  });

  it('【关键】非法迁移均不在表中（如 RETURNED→LENT、LENT→APPROVED）', () => {
    expect(BORROW_TRANSITIONS.RETURNED).not.toContain('LENT');
    expect(BORROW_TRANSITIONS.LENT).not.toContain('APPROVED');
    expect(BORROW_TRANSITIONS.OVERDUE).not.toContain('LENT');
    expect(BORROW_TRANSITIONS.REJECTED).not.toContain('PENDING');
  });
});

// ============================================================================
describe('审批 —— 状态与权限', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('非 PENDING 状态审批 → BORROW_INVALID_STATE(3001)', async () => {
    h = makeHarness(makeOrder({ status: BorrowStatus.LENT }));
    await expect(
      h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '同意借阅' }, makeUser()),
    ).rejects.toMatchObject({ code: 3001 });
  });

  it('【关键】禁止自审：申请人与审批人相同 → FORBIDDEN(1003)', async () => {
    const self = makeUser({ userId: 'u-applicant' });
    await expect(
      h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '同意' }, self),
    ).rejects.toMatchObject({ code: 1003 });
  });

  it('审批意见缺失（<2 字）→ BAD_REQUEST(1001)', async () => {
    await expect(
      h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '好' }, makeUser()),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('PUBLIC/INTERNAL 单级审批 → APPROVED', async () => {
    h = makeHarness(makeOrder({ requiredLevel: 1, currentLevel: 1 }));
    const dto = await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '同意借阅' },
      makeUser(),
    );
    expect(dto.status).toBe(BorrowStatus.APPROVED);
  });

  it('驳回 → REJECTED（终态）', async () => {
    const dto = await h.service.approve(
      'o-1',
      { action: ApprovalAction.REJECT, opinion: '用途不充分' },
      makeUser(),
    );
    expect(dto.status).toBe(BorrowStatus.REJECTED);
  });

  it('【关键】SECRET 双级审批：第 1 级通过后仍为 PENDING 且 currentLevel=2', async () => {
    h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }));
    const afterFirst = await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '一级同意' },
      makeUser({ roles: ['R1'] }),
    );
    expect(afterFirst.status).toBe(BorrowStatus.PENDING);
    expect((h.state.order as { currentLevel: number }).currentLevel).toBe(2);
  });

  it('【关键】SECRET 第 2 级通过后才 APPROVED', async () => {
    h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 2 }));
    const dto = await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '二级同意' },
      makeUser({ roles: ['R4'] }),
    );
    expect(dto.status).toBe(BorrowStatus.APPROVED);
  });

  it('审批次序错误（跳过第 1 级直接审第 2 级）→ 3001', async () => {
    h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }));
    await expect(
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '越级审批', level: 2 },
        makeUser(),
      ),
    ).rejects.toMatchObject({ code: 3001 });
  });

  it('每次审批都留痕（borrow_approval 落库）', async () => {
    await h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '同意借阅' }, makeUser());
    // 留痕走 approvalRepo（状态推进成功之后写，避免并发失败方污染审批链）
    expect(h.approvalRepo.save, '审批记录必须落库一次').toHaveBeenCalledTimes(1);
    const saved = h.state.approvals[0] as { opinion: string; level: number; action: string };
    expect(saved.opinion).toBe('同意借阅');
    expect(saved.level).toBe(1);
    expect(saved.action).toBe('APPROVE');
  });
});

// ============================================================================
describe('借出 / 归还 / 撤销 / 续借', () => {
  it('借出：APPROVED → LENT', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.APPROVED }));
    const dto = await h.service.lend('o-1', makeUser());
    expect(dto.status).toBe(BorrowStatus.LENT);
  });

  it('借出：PENDING 直接借出 → 3001（跳过审批）', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.PENDING }));
    await expect(h.service.lend('o-1', makeUser())).rejects.toMatchObject({ code: 3001 });
  });

  it('归还：LENT → RETURNED 并写入 actual_return', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.LENT }));
    const dto = await h.service.giveBack('o-1', '完好归还', makeUser());
    expect(dto.status).toBe(BorrowStatus.RETURNED);
    expect(h.state.order.actualReturn).toBeInstanceOf(Date);
    expect(h.state.order.returnRemark).toBe('完好归还');
  });

  it('归还：OVERDUE → RETURNED 合法', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.OVERDUE }));
    const dto = await h.service.giveBack('o-1', undefined, makeUser());
    expect(dto.status).toBe(BorrowStatus.RETURNED);
  });

  it('归还：PENDING 状态归还 → 3001', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.PENDING }));
    await expect(h.service.giveBack('o-1', undefined, makeUser())).rejects.toMatchObject({
      code: 3001,
    });
  });

  it('归还：终态 RETURNED 再归还 → 3001', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.RETURNED }));
    await expect(h.service.giveBack('o-1', undefined, makeUser())).rejects.toMatchObject({
      code: 3001,
    });
  });

  it('撤销：仅申请人本人可撤销（否则 3005）', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.PENDING }));
    await expect(
      h.service.cancel('o-1', makeUser({ userId: 'someone-else' })),
    ).rejects.toMatchObject({ code: 3005 });
  });

  it('撤销：本人 PENDING → CANCELLED', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.PENDING }));
    const dto = await h.service.cancel('o-1', makeUser({ userId: 'u-applicant' }));
    expect(dto.status).toBe(BorrowStatus.CANCELLED);
  });

  it('撤销：已借出（LENT）不可撤销 → 3001', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.LENT }));
    await expect(
      h.service.cancel('o-1', makeUser({ userId: 'u-applicant' })),
    ).rejects.toMatchObject({ code: 3001 });
  });

  it('续借：非本人 → 3005', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.LENT, expectReturn: '2099-01-01' }));
    await expect(
      h.service.renew('o-1', makeUser({ userId: 'other' })),
    ).rejects.toMatchObject({ code: 3005 });
  });

  it('续借：非 LENT 状态 → 3001', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.APPROVED }));
    await expect(
      h.service.renew('o-1', makeUser({ userId: 'u-applicant' })),
    ).rejects.toMatchObject({ code: 3001 });
  });

  it('续借：首次可续，第 2 次触顶 → 3004', async () => {
    // 注意：源码 assertExpectReturn 校验的是「距今天数 ≤ 90」，
    // 而非「本次续借延长天数」，这里用近期到期日构造真实场景。
    const inTenDays = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const h = makeHarness(
      makeOrder({ status: BorrowStatus.LENT, renewCount: 0, expectReturn: inTenDays }),
    );
    const after = await h.service.renew('o-1', makeUser({ userId: 'u-applicant' }), 10);
    expect(after.renewCount).toBe(1);
    await expect(
      h.service.renew('o-1', makeUser({ userId: 'u-applicant' }), 10),
    ).rejects.toMatchObject({ code: 3004 });
  });
});

// ============================================================================
describe('借阅申请边界（借期 / 逾期 / 重复）', () => {
  it('借阅目的 < 5 字 → 1001', async () => {
    const h = makeHarness();
    await expect(
      h.service.create(
        {
          itemId: 'i-1',
          purpose: '看看',
          mode: BorrowMode.ONLINE,
          expectReturn: '2099-01-01',
        },
        makeUser({ userId: 'u-applicant' }),
      ),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('预计归还日期早于明天 → 1001', async () => {
    const h = makeHarness();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await expect(
      h.service.create(
        {
          itemId: 'i-1',
          purpose: '编写年度工作报告',
          mode: BorrowMode.ONLINE,
          expectReturn: yesterday,
        },
        makeUser({ userId: 'u-applicant' }),
      ),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('借期超过 90 天 → 1001', async () => {
    const h = makeHarness();
    const tooFar = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
    await expect(
      h.service.create(
        {
          itemId: 'i-1',
          purpose: '编写年度工作报告',
          mode: BorrowMode.ONLINE,
          expectReturn: tooFar,
        },
        makeUser({ userId: 'u-applicant' }),
      ),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('已有逾期未还 → 3002 拒绝新申请', async () => {
    const h = makeHarness();
    h.orderRepo.count.mockImplementation(async ({ where }: { where: { status?: string } }) =>
      where?.status === BorrowStatus.OVERDUE ? 2 : 0,
    );
    await expect(
      h.service.create(
        {
          itemId: 'i-1',
          purpose: '编写年度工作报告',
          mode: BorrowMode.ONLINE,
          expectReturn: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        },
        makeUser({ userId: 'u-applicant' }),
      ),
    ).rejects.toMatchObject({ code: 3002 });
  });

  it('同一档案已有进行中单据 → 3003', async () => {
    const h = makeHarness();
    h.orderRepo.count.mockImplementation(async ({ where }: { where: { itemId?: string } }) =>
      where?.itemId ? 1 : 0,
    );
    await expect(
      h.service.create(
        {
          itemId: 'i-1',
          purpose: '编写年度工作报告',
          mode: BorrowMode.ONLINE,
          expectReturn: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        },
        makeUser({ userId: 'u-applicant' }),
      ),
    ).rejects.toMatchObject({ code: 3003 });
  });

  it('SECRET 档案自动路由为 2 级审批（requiredLevel=2）', async () => {
    const h = makeHarness();
    h.orderRepo.save.mockImplementation(async (v: Order) => {
      h.state.order = { ...v, id: 'o-new', createdAt: new Date() };
      return h.state.order;
    });
    const dto = await h.service.create(
      {
        itemId: 'i-1',
        purpose: '编写年度工作报告',
        mode: BorrowMode.ONLINE,
        expectReturn: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      },
      makeUser({ userId: 'u-applicant' }),
    );
    expect(dto.status).toBe(BorrowStatus.PENDING);
    expect((h.state.order as { requiredLevel: number }).requiredLevel).toBe(2);
  });

  it('无权访问的档案（密级/范围不足）→ FORBIDDEN(1003)', async () => {
    const h = makeHarness();
    (h.service as unknown as { accessBuilder: { canAccessRecord: ReturnType<typeof vi.fn> } })
      .accessBuilder.canAccessRecord = vi.fn(() => false);
    await expect(
      h.service.create(
        {
          itemId: 'i-1',
          purpose: '编写年度工作报告',
          mode: BorrowMode.ONLINE,
          expectReturn: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        },
        makeUser({ userId: 'u-applicant' }),
      ),
    ).rejects.toMatchObject({ code: 1003 });
  });
});

// ============================================================================
describe('逾期扫描', () => {
  it('LENT 且已过期 → OVERDUE，并写审计', async () => {
    const h = makeHarness();
    h.orderRepo.find = vi.fn(async () => [
      { ...makeOrder({ status: BorrowStatus.LENT, expectReturn: '2000-01-01' }) },
    ]);
    const n = await h.service.scanOverdue();
    expect(n).toBe(1);
    expect((h.state.order as { status: BorrowStatus }).status).toBe(BorrowStatus.OVERDUE);
    expect(h.auditLog.append).toHaveBeenCalledTimes(1);
  });

  it('无逾期单 → 返回 0 且无副作用', async () => {
    const h = makeHarness();
    h.orderRepo.find = vi.fn(async () => []);
    expect(await h.service.scanOverdue()).toBe(0);
    expect(h.auditLog.append).not.toHaveBeenCalled();
  });
});
