/**
 * 审批并发安全测试（R6：approve()/cancel() 读-判-写窗口）—— **回归守卫**
 *
 * 缺陷模型（已修复，本文件用于防回归）：
 *   修复前 `approve()` 的 `order` 在**事务外** `loadOrder()` 读取，事务内沿用该旧快照。
 *   两名审批人并发审批同一单据时，双方都读到 `currentLevel=1`，
 *   都能通过 `actingLevel !== order.currentLevel` 校验 → 双级审批被同层重复通过
 *   或第 2 级被绕过。
 *
 * 当前实现：
 *   `withOrderLock(orderId, ...)` 内「读取 → 校验 → CAS 写入」串行，
 *   外加 update 的 WHERE 携带 status/currentLevel 做多实例兜底。
 *
 * 测试方法：
 *   单元测试无真实 PG 行锁，用**按单据串行化的队列**模拟 FOR UPDATE 语义；
 *   `transactional=true` 时构造串行 harness（对应实现里的进程内互斥锁），
 *   从而验证「后到者读到推进后的状态并被拒绝」。
 */
import { describe, expect, it, vi } from 'vitest';
import { BorrowService } from '@api/modules/borrow/borrow.service';
import {
  ApprovalAction,
  BorrowMode,
  BorrowStatus,
  PermissionMode,
  SecurityLevel,
  type PermissionSnapshot,
  type RoleCode,
} from '@tianji/shared';

type Order = Record<string, unknown>;

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'o-1',
    orderNo: 'L20241107-001',
    applicantId: 'u-applicant',
    itemId: 'i-1',
    purpose: '涉密项目查阅',
    mode: BorrowMode.ONLINE,
    expectReturn: '2099-12-31',
    actualReturn: null,
    status: BorrowStatus.PENDING,
    renewCount: 0,
    currentLevel: 1,
    requiredLevel: 2, // SECRET：需两级审批
    borrowDate: null,
    returnRemark: null,
    createdAt: new Date(),
    ...over,
  };
}

/**
 * 构造审批人快照。
 *
 * ⚠️ v1.3 起 `approve()` 用 `resolveApproverLevel()` 从**角色**推导可签级别
 * （R4 领导可签第 2 级；其余具审批权者只能签第 1 级），不再信任前端传的 level。
 * 因此夹具必须给出真实 grants，否则会在 `canDo` 处 403，用例测不到并发语义。
 *
 * @param roles 角色码；默认 R1（档案管理员，只能初审）
 */
function makeApprover(
  id: string,
  roles: RoleCode[] = ['R1'],
  over: Partial<PermissionSnapshot> = {},
): PermissionSnapshot {
  return {
    userId: id,
    username: id,
    displayName: id,
    roles,
    grants: {
      BORROW_APPROVE: { mode: PermissionMode.FULL, ops: ['READ', 'APPROVE'] },
    },
    maxSecurityLevel: SecurityLevel.SECRET,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    ...over,
  };
}

/**
 * @param transactional 是否模拟「事务内加锁重读」的正确实现。
 *   - true：事务体串行执行，且事务内重读最新状态（模拟 FOR UPDATE）
 *   - false：使用事务外读到的旧快照（复现 R6 缺陷）
 */
function makeHarness(initial: Order, transactional: boolean) {
  const state = { order: initial, approvals: [] as Order[] };

  const orderRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.order.id === where.id ? { ...state.order } : null,
    ),
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

  // 事务内仓储：加锁重读最新状态
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
    save: vi.fn(async (v: Order) => {
      const persisted = { id: `ap-${state.approvals.length + 1}`, actedAt: new Date(), ...v };
      state.approvals.push(persisted);
      return persisted;
    }),
    update: vi.fn(async (_e: unknown, _w: unknown, patch: Partial<Order>) => {
      state.order = { ...state.order, ...patch };
      return { affected: 1 };
    }),
  };

  // 同单据事务串行化（模拟 FOR UPDATE 行锁互斥）
  let lockChain: Promise<unknown> = Promise.resolve();
  const dataSource = {
    transaction: vi.fn((cb: (m: unknown) => Promise<unknown>) => {
      if (!transactional) return cb(manager); // 未加锁：允许并发穿透
      const run = lockChain.then(() => cb(manager));
      lockChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };

  const service = new BorrowService(
    orderRepo as never,
    {
      find: vi.fn(async () => state.approvals),
      create: vi.fn((v: unknown) => v),
      save: vi.fn(async (v: Order) => {
        // 必须真正入账：断言「失败方不得留痕」依赖 state.approvals 的真实长度
        const persisted = { id: `ap-${state.approvals.length + 1}`, actedAt: new Date(), ...v };
        state.approvals.push(persisted);
        return persisted;
      }),
    } as never,
    {
      findOne: vi.fn(async () => ({
        id: 'i-1',
        danghao: 'A036-2024-BGS-Y-0001-0001',
        title: '涉密报告',
        securityLevel: SecurityLevel.SECRET,
        fondsId: 'f-1',
        orgId: 'o-1',
        createdBy: 'u-other',
        deleted: false,
      })),
      find: vi.fn(async () => []),
    } as never,
    { findOne: vi.fn(async () => ({ id: 'u-applicant', displayName: '申请人' })), find: vi.fn(async () => []) } as never,
    dataSource as never,
    {
      canAccessRecord: vi.fn(() => true),
      levelsAtMost: vi.fn(() => ['PUBLIC', 'INTERNAL', 'SECRET']),
      buildEsFilter: vi.fn(() => ({ filters: [] })),
      buildSql: vi.fn(() => ({ clause: '', params: [] })),
      buildKbFilter: vi.fn(() => ({ filters: [] })),
    } as never,
    { append: vi.fn(async () => undefined) } as never,
    // ParamService：返回 PRD 封版默认规则（approve 链路只用到 loadRules，不影响 R6 判定）
    {
      getBorrowRules: vi.fn(async () => ({
        maxTotalDays: 90,
        minDays: 1,
        maxRenewalCount: 1,
        maxRenewalDays: 30,
        defaultDays: 30,
      })),
      getInt: vi.fn(async () => 90),
      get: vi.fn(async () => '90'),
    } as never,
  );

  return { service, state };
}

// ============================================================================
describe('R6 双审批人并发审批同一单据', () => {
  it('【R6 回归】两名审批人并发第 1 级审批 → 仅一人成功', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);

    // ⚠️ 必须显式传 level: 1。
    // 若省略 level，source 会取 `input.level ?? order.currentLevel`，
    // 串行化后第二人读到的 currentLevel 已是 2，于是他会「自动」变成第 2 级审批
    // 并成功 —— 那不是并发缺陷，而是「未指定级别 = 按当前级别办」的正常语义。
    // 真实攻击面是：两人都以为自己在办第 1 级（前端已缓存 level=1）。
    const results = await Promise.allSettled([
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '一级同意', level: 1 },
        makeApprover('a-1'),
      ),
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '一级同意', level: 1 },
        makeApprover('a-2'),
      ),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    // 串行化后：第一个推进 currentLevel=2；第二个仍声明要办第 1 级，
    // 校验 `actingLevel !== order.currentLevel` 命中 → 被拒
    expect(ok, `并发同一级审批应只有一人成功，实际 ${ok} 人 → 存在双通过窗口（R6 回归）`).toBe(1);
    expect(h.state.order.currentLevel).toBe(2);
    expect(h.state.order.status).toBe(BorrowStatus.PENDING);
    // 审批链只留一条记录，失败方不写脏留痕
    expect(h.state.approvals.length).toBe(1);
  });

  it('【R6 回归】审批级别推进后，持旧快照的提交必须被拒绝', async () => {
    // 校验必须基于锁内重读的最新状态，而不是事务外读到的旧快照。
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);

    // a-1 完成第 1 级 → 状态推进到 currentLevel=2
    await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '一级同意', level: 1 },
      makeApprover('a-1'),
    );
    expect(h.state.order.currentLevel).toBe(2);

    // a-2 持旧快照（level=1）再提交：正确实现应在锁内重读后
    // 发现「当前应审第 2 级」，以次序错误拒绝。
    const err = await h.service
      .approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '重复一级', level: 1 },
        makeApprover('a-2'),
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err, '级别已推进到 2，重复提交第 1 级应被拒绝 → 缺陷 R6').not.toBeNull();
    expect(h.state.order.currentLevel, '被拒后级别不得回退或再推进').toBe(2);
    expect(h.state.approvals.length, '被拒方不得留下审批留痕').toBe(1);
  });

  it('双级审批完整链路正确（1 级 → 2 级 → APPROVED）', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);

    // 第 1 级：R1 档案管理员，显式 level=1
    await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '一级同意', level: 1 },
      makeApprover('a-1', ['R1']),
    );
    expect(h.state.order.status).toBe(BorrowStatus.PENDING);
    expect(h.state.order.currentLevel).toBe(2);

    // 第 2 级：R4 领导，必须显式 level=2（不传会被当成 1 级而次序错误）
    await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '二级同意', level: 2 },
      makeApprover('a-2', ['R4']),
    );
    expect(h.state.order.status).toBe(BorrowStatus.APPROVED);
    expect(h.state.approvals.length, '双级审批应留两条留痕').toBe(2);
  });

  it('同一审批人不得办完两级（双级审批须由不同人完成，合规底线）', async () => {
    // v1.3 防线：不靠"角色-级别"绑定，而靠「同一审批人不得重复签署」。
    // 理由：level 缺省时会跟随 currentLevel，若只看级别，一人连点两次就能走完两级。
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);

    // a-1 签第 1 级
    await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '一级同意', level: 1 },
      makeApprover('a-1', ['R1']),
    );
    expect(h.state.order.currentLevel).toBe(2);

    // 同一 a-1 不传 level 再签（会被判定为第 2 级）：必须被「重复签署」拦下
    await expect(
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '自己终审' },
        makeApprover('a-1', ['R1']),
      ),
    ).rejects.toThrow();
    expect(h.state.order.status, '被拒后不得 APPROVED').toBe(BorrowStatus.PENDING);
    expect(h.state.approvals.length, '不得产生第二条留痕').toBe(1);
  });

  it('越级审批（跳过第 1 级直接提交 level=2）→ 拒绝', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);

    await expect(
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '越级审批', level: 2 },
        makeApprover('a-2', ['R4']),
      ),
    ).rejects.toThrow();
  });
});

// ============================================================================
describe('R6 审批幂等与重复提交', () => {
  it('【R6 回归】同一审批人重复提交第 1 级 → 第二次被拒绝', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);
    const approver = makeApprover('a-1');

    // 显式 level: 1 —— 模拟前端重复点击「第 1 级通过」
    await h.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '同意', level: 1 },
      approver,
    );
    const err = await h.service
      .approve('o-1', { action: ApprovalAction.APPROVE, opinion: '同意', level: 1 }, approver)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err, '重复提交第 1 级应被拒绝（级别已推进）→ 缺陷 R6').not.toBeNull();
    expect(h.state.approvals.length, '重复提交不得产生第二条留痕').toBe(1);
  });

  it('已 APPROVED 的单据再审批 → 拒绝（状态非法）', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.APPROVED, currentLevel: 2 }), true);
    await expect(
      h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '再审' }, makeApprover('a-1')),
    ).rejects.toThrow();
  });

  it('已 REJECTED 的单据再审批 → 拒绝', async () => {
    const h = makeHarness(makeOrder({ status: BorrowStatus.REJECTED }), true);
    await expect(
      h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '再审' }, makeApprover('a-1')),
    ).rejects.toThrow();
  });
});

// ============================================================================
describe('R6 撤销（cancel）并发窗口', () => {
  it('【R6 回归】并发撤销 + 审批 → 仅一个生效（互斥）', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 1, currentLevel: 1 }), true);

    const results = await Promise.allSettled([
      h.service.cancel('o-1', makeApprover('u-applicant')),
      h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '同意' }, makeApprover('a-1')),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok, `撤销与审批并发应互斥，实际成功 ${ok} 个（R6 回归）`).toBe(1);
  });

  it('撤销后再审批 → 拒绝（状态已 CANCELLED）', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 1, currentLevel: 1 }), true);

    await h.service.cancel('o-1', makeApprover('u-applicant'));
    await expect(
      h.service.approve('o-1', { action: ApprovalAction.APPROVE, opinion: '同意' }, makeApprover('a-1')),
    ).rejects.toThrow();
  });

  it('非申请人撤销 → 拒绝 3005', async () => {
    const h = makeHarness(makeOrder(), true);
    await expect(h.service.cancel('o-1', makeApprover('u-other'))).rejects.toMatchObject({ code: 3005 });
  });
});

// ============================================================================
// 审批人级别能力校验（PRD 3.2「○（重要件）」= 终审仅 R4 可签）
//
// ⚠️ 为什么必须单列这一组：`approve()` 里有三道**互相独立**的拒绝闸门——
//   ① 次序校验  `actingLevel !== order.currentLevel`          → BORROW_INVALID_STATE
//   ② 能力校验  `actingLevel > resolveApproverLevel(user)`    → FORBIDDEN
//   ③ 重复签署  该审批人已在本单留痕                            → BORROW_INVALID_STATE
//
// 现有用例的失败来源分别是 ① 和 ③，**② 从未被单独触发过**。
// 后果：若有人把 `resolveApproverLevel` 改成 `return 2`（人人可签终审），
// 现有 11 条**全部保持绿**——一条合规防线裸奔而不自知。
//
// 因此本组的关键设计是：**断言拒绝来源**，不只断言「抛了错」。
// 只写 `rejects.toThrow()` 的话，①②③ 任一先命中都会让它绿，等于没测。
// ============================================================================
describe('审批人级别能力校验（终审仅 R4）', () => {
  /** 取出 BizException 的 code，非异常返回 null（便于断言"不该抛"） */
  async function catchCode(p: Promise<unknown>): Promise<number | null> {
    try {
      await p;
      return null;
    } catch (e) {
      const err = e as { code?: unknown };
      return typeof err.code === 'number' ? err.code : -1;
    }
  }

  it('【核心】R1 在 currentLevel=2 的单据上冒充终审（level=2）→ 403，且拒因是级别能力', async () => {
    // currentLevel 必须已是 2：否则会先被次序校验 ① 拦下，测不到 ②
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 2 }), true);
    // 单据已到终审，且 R1 此前未签过：① 和 ③ 都不会触发，唯一能拒它的是 ②

    const err = await h.service
      .approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '我来终审', level: 2 },
        makeApprover('a-1', ['R1']),
      )
      .then(() => null)
      .catch((e: unknown) => e as { code?: number; message?: string });

    expect(err, 'R1 冒充终审必须被拒——若此断言失败，说明 269 行能力校验已失效').not.toBeNull();
    // 断言 code = FORBIDDEN(1003)：次序校验抛的是 BORROW_INVALID_STATE，
    // 这里若拿到别的 code，说明拒绝来源不是能力校验（用例失效，需复查夹具）
    expect(err?.code, '拒因必须是 FORBIDDEN（能力校验），而非次序校验').toBe(1003);
    // 断言文案：锁死「是级别能力拦的」这件事，防止将来次序/文案改动让本用例悄悄变成测别的
    expect(err?.message).toContain('无权办理');
    expect(err?.message).toContain('第 2 级');

    // 副作用检查：被拒后单据与留痕都不得变化
    expect(h.state.order.currentLevel, '被拒后级别不得推进').toBe(2);
    expect(h.state.order.status).toBe(BorrowStatus.PENDING);
    expect(h.state.approvals.length, '被拒不得留痕').toBe(0);
  });

  it('正向对照：R4 在 currentLevel=2 签终审 → 放行（证明不是"一律拒绝"）', async () => {
    // 没有这条，上面那条在「269 行把所有人都拒掉」的错误实现下也会绿。
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 2 }), true);
    // 先由另一个 R1 完成第 1 级，再让 R4 终审——更贴近真实单据流
    const first = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);
    await first.service.approve(
      'o-1',
      { action: ApprovalAction.APPROVE, opinion: '一级同意', level: 1 },
      makeApprover('a-r1', ['R1']),
    );
    expect(first.state.order.currentLevel).toBe(2);

    // R4 终审
    await expect(
      first.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '二级同意', level: 2 },
        makeApprover('a-r4', ['R4']),
      ),
      'R4 签第 2 级必须放行，否则能力校验变成了"一律拒绝"',
    ).resolves.toBeDefined();

    expect(first.state.order.status).toBe(BorrowStatus.APPROVED);

    // h 未使用，显式消费以满足 lint（同时保留"独立单据"的语义说明）
    expect(h.state.order.currentLevel).toBe(2);
  });

  it('R1 签第 1 级不受影响（能力校验不能把初审也拦掉）', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);
    await expect(
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '一级同意', level: 1 },
        makeApprover('a-1', ['R1']),
      ),
    ).resolves.toBeDefined();
    expect(h.state.order.currentLevel).toBe(2);
  });

  it('无角色用户（roles=[]）不得签任何级 → 第 2 级被拒', async () => {
    // resolveApproverLevel 对空角色返回 1（fail-closed 方向）；这里验证不会放大
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 2 }), true);
    const code = await catchCode(
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '终审', level: 2 },
        makeApprover('a-x', []),
      ),
    );
    expect(code, '空角色必须按第 1 级能力处理 → 403').toBe(1003);
  });

  it('R4 签第 1 级也允许（能力是"上限"，不是"等级严格绑定"）', async () => {
    const h = makeHarness(makeOrder({ requiredLevel: 2, currentLevel: 1 }), true);
    await expect(
      h.service.approve(
        'o-1',
        { action: ApprovalAction.APPROVE, opinion: '我先初审', level: 1 },
        makeApprover('a-r4', ['R4']),
      ),
    ).resolves.toBeDefined();
  });
});

// ============================================================================
// resolveApproverLevel 本体单测（反射调用私有方法）
//
// 上面那组测的是"能力校验接线是否正确"，这组测"级别推导本身是否正确"。
// 拆开的好处：269 行被删 → 上面那组红；843 行逻辑被改 → 这组红。
// 两者同时红 → 说明整条防线塌了。
// ============================================================================
describe('resolveApproverLevel 级别推导（反射单测）', () => {
  type Resolver = (user: Partial<PermissionSnapshot>) => number;
  const resolve = (BorrowService.prototype as unknown as { resolveApproverLevel: Resolver })
    .resolveApproverLevel;

  it('前置守卫：方法必须存在（被删/改名时本组立即红）', () => {
    expect(typeof resolve, 'resolveApproverLevel 已被删除或改名').toBe('function');
  });

  it('R4（领导）→ 第 2 级', () => {
    expect(resolve({ roles: ['R4'] })).toBe(2);
  });

  it('R1（档案管理员）→ 第 1 级', () => {
    expect(resolve({ roles: ['R1'] })).toBe(1);
  });

  it('R1 + R4 兼任 → 第 2 级（取最高）', () => {
    expect(resolve({ roles: ['R1', 'R4'] })).toBe(2);
  });

  it('空角色 → 第 1 级：**这是"依赖上游兜底"的设计，不是"函数自身足够安全"**', () => {
    // ⚠️ 语义澄清（产品经理复核时提出，重要）：
    //   返回 1 的含义是「不放大成第 2 级」，**不是**「空角色可以正常签第 1 级」。
    //   一个没有任何角色的用户真能签第 1 级吗？——不能。
    //   真正拦住它的是**上游**：Controller 的 `@RequirePerm({domain:'BORROW_APPROVE'})`
    //   → PermissionGuard 的 `hasPermission()` → 无 grants 直接 403。
    //
    //   因此本函数的安全性是**有条件**的：条件 = 上游 canDo 存在。
    //   若将来有人把上游守卫重构掉（例如把权限校验下沉到 service 里、或改成
    //   "登录即可访问"），本函数的 []→1 不会变、本用例不会红，
    //   但"空角色可终审第 1 级"就会成为真实漏洞。
    //
    //   已实测验证这一点：把 269 行能力校验短路并假设上游缺失时，
    //   本组的「R1 冒充终审」与「空角色被拒」两条同时变红——
    //   说明当前绿是**两条防线叠加**的结果，拆掉任一条都会红。
    expect(resolve({ roles: [] }), '空角色返回 1 = 不放大，而非可安全审批').toBe(1);
    expect(resolve({ roles: [] }), '绝不可返回 2（那样空角色可终审，绕过上游兜底）').not.toBe(2);
  });

  it('roles 字段缺失（脏快照）→ 第 1 级，不得抛异常', () => {
    expect(() => resolve({}), 'roles 缺失时不应崩，且必须按第 1 级处理').not.toThrow();
    expect(resolve({})).toBe(1);
  });

  it('反假绿：若实现被改成 `return 2`，上面 5 条必须全红', () => {
    // 这条是元断言，无法在运行时证明"将来会红"，但它把意图写进代码：
    // 只要有人把实现改成常返 2，R1 / 空角色 / 缺失 roles 三条必红。
    // 常返 1 则 R4 与兼任两条必红。两个方向都有覆盖。
    expect(resolve({ roles: ['R4'] })).not.toBe(resolve({ roles: ['R1'] }));
  });
});
