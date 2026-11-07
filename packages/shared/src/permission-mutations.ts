/**
 * 权限变更入口清单（PERMISSION_MUTATIONS）—— **单一源**，放在 shared。
 *
 * ## 为什么需要这份清单
 *
 * 「撤权即时生效」（PRD 5.5 C-5 / F-09）依赖每一处权限变更都调用
 * `UserService.invalidateSnapshot()`。漏掉第 11 处，症状是「某类变更要等
 * TTL 到期才生效」——很难在验收时被注意到。因此把入口集中登记，
 * 由 CI 静态自检核对：「凡清单成员被调用，同一执行路径必须存在
 * invalidateSnapshot 调用」。
 *
 * ## 清单口径
 *
 * 只收录**会导致某用户权限快照内容变化**的入口：
 * 改角色、改数据范围、改角色的功能域授权、停用账号、改密/重置密码、删号。
 *
 * ## 显式排除（重要，勿「顺手补上」）
 *
 * - `BorrowService.approve()` 里的自审拦截（`order.applicantId === user.userId`）：
 *   那是**防自审**，不是撤权场景。它直接比对字段、**不读权限快照**，
 *   补 invalidate 属于无效代码，还会误导后来人以为审批链路走快照。
 * - 登录成功后的 `invalidateSnapshot`：属于「预热重建」而非「撤权」，
 *   不在本清单口径内。
 *
 * CI 自检须显式排除上述自审比对点，避免被扫成「疑似遗漏」。
 */

/** 单个权限变更入口 */
export interface PermissionMutationEntry {
  /** 稳定的标识（用于 CI 自检报错定位，不随文件移动而变） */
  readonly id: string;
  /** 所属服务类名 */
  readonly service: string;
  /** 方法名 */
  readonly method: string;
  /** 该入口影响谁的快照（便于人工核对是否覆盖了所有受影响用户） */
  readonly affects: string;
  /** 说明 */
  readonly note: string;
}

/**
 * 权限变更入口全清单。
 *
 * 新增任何会改快照内容的方法，**必须**在此登记，否则 CI 静态自检不会保护它。
 */
export const PERMISSION_MUTATIONS: readonly PermissionMutationEntry[] = [
  {
    id: 'user-admin.create',
    service: 'UserAdminService',
    method: 'create',
    affects: '新用户（无既有快照，调用 invalidate 为幂等防御）',
    note: '新建账号，同时可能带入初始角色',
  },
  {
    id: 'user-admin.update',
    service: 'UserAdminService',
    method: 'update',
    affects: '目标用户（角色变化时）',
    note: '改资料 / 改角色，角色变化直接影响快照 roles/grants',
  },
  {
    id: 'user-admin.disable',
    service: 'UserAdminService',
    method: 'disable',
    affects: '目标用户',
    note: '停用账号须立即失效，否则旧快照仍可访问',
  },
  {
    id: 'user-admin.update-role-permissions',
    service: 'UserAdminService',
    method: 'updateRolePermissions',
    affects: '该角色下**全部**用户',
    note: '改角色功能域授权，影响面最大的一条，必须整角色广播失效',
  },
  {
    id: 'user-admin.update-user-scopes',
    service: 'UserAdminService',
    method: 'updateUserScopes',
    affects: '目标用户',
    note: '改数据范围（档案馆/机构），直接改变可见数据集合',
  },
  {
    id: 'auth.change-password',
    service: 'AuthService',
    method: 'changePassword',
    affects: '本人',
    note: '本人改密后旧会话快照失效',
  },
  {
    id: 'auth.logout',
    service: 'AuthService',
    method: 'logout',
    affects: '本人',
    note: '登出清理快照（与吊销 refresh 配套）',
  },
  {
    id: 'user.update-password-hash',
    service: 'UserService',
    method: 'updatePasswordHash',
    affects: '目标用户',
    note:
      '密码哈希落库（改密/重置共用）后必须让旧快照失效。' +
      '注意本方法自身**不**内联 invalidate，由调用方（AuthService.changePassword）负责，' +
      'CI 自检须按「执行路径」而非「方法体内」判定',
  },
];

/**
 * 显式排除项：**不**属于权限变更，禁止为其补 invalidate。
 *
 * CI 静态自检读到这些位置时应跳过，不要报「疑似遗漏」。
 */
export interface PermissionMutationExclusion {
  readonly id: string;
  readonly service: string;
  readonly method: string;
  readonly reason: string;
}

/**
 * 排除清单。
 *
 * 现仅一条：借阅审批的**自审拦截**。它做的是 `order.applicantId === user.userId`
 * 的字段比对，全程不读权限快照，因此与撤权链路无关。
 */
export const PERMISSION_MUTATION_EXCLUSIONS: readonly PermissionMutationExclusion[] = [
  {
    id: 'borrow.approve.self-check',
    service: 'BorrowService',
    method: 'approve',
    reason:
      '防自审的字段比对（applicantId === userId），不读权限快照；' +
      '补 invalidate 是无效代码，且会误导后来人以为审批链路依赖快照',
  },
];

/** 按 id 查入口（CI 自检与测试使用） */
export function findPermissionMutation(id: string): PermissionMutationEntry | undefined {
  return PERMISSION_MUTATIONS.find((m) => m.id === id);
}

/** 全部需守卫的 `Service.method` 组合，供 CI 自检遍历 */
export function permissionMutationKeys(): string[] {
  return PERMISSION_MUTATIONS.map((m) => `${m.service}.${m.method}`);
}
