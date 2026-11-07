/**
 * 权限声明与判定（四要素：角色 × 数据范围 × 密级 × 操作）
 *
 * 本文件只包含「纯函数」判定逻辑，前后端共用：
 *  - 前端：决定按钮是否置灰与 title 原因（PermGate 组件）；
 *  - 后端：PermissionGuard 做服务端最终裁决（前端仅展示态）。
 */

import {
  OperationType,
  PermissionDomain,
  PermissionGrant,
  PermissionMode,
  RoleCode,
  SecurityLevel,
  SECURITY_LEVEL_RANK,
} from './enums';

/** 用户的权限快照（服务端生成，随 JWT / GET /auth/profile 下发） */
export interface PermissionSnapshot {
  userId: string;
  username: string;
  displayName: string;
  roles: RoleCode[];
  /** 功能域 → 授权声明 */
  grants: Partial<Record<PermissionDomain, PermissionGrant>>;
  /** 密级上限 */
  maxSecurityLevel: SecurityLevel;
  /** 数据范围 */
  scopes: Array<{ scopeType: 'ALL' | 'FONDS' | 'ORG' | 'SELF'; scopeRefId: string | null }>;
  /** 授权的全宗 ID 列表（由 scopes 展开，ALL 时为 null 表示不限） */
  fondsIds: string[] | null;
  /** 授权的机构 ID 列表 */
  orgIds: string[] | null;
  /** 是否仅本人数据 */
  selfOnly: boolean;
}

/**
 * 判定是否拥有「功能域 × 操作」权限。
 * 数据范围与密级需另行判定（见 AccessFilterBuilder）。
 */
export function hasPermission(
  snapshot: PermissionSnapshot | null | undefined,
  domain: PermissionDomain,
  op: OperationType,
): boolean {
  if (!snapshot) return false;
  const grant = snapshot.grants?.[domain];
  if (!grant) return false;
  if (grant.mode === PermissionMode.NONE) return false;
  if (grant.mode === PermissionMode.READONLY && op !== 'READ') return false;
  return Array.isArray(grant.ops) && grant.ops.includes(op);
}

/**
 * 判定能否访问指定密级的档案。
 * 规则：`itemLevel <= user.maxSecurityLevel`；若功能域标记 levelCapped=false 则不受限（如管理员查看系统运行统计）。
 *
 * 安全约束（fail-closed）：任一密级值不在枚举内（脏数据 / 将来新增档位而老代码未同步），
 * 一律判定为不可访问，绝不回落为 rank 0 放大权限。
 */
export function canAccessLevel(
  snapshot: PermissionSnapshot | null | undefined,
  level: SecurityLevel,
  domain?: PermissionDomain,
): boolean {
  if (!snapshot) return false;
  if (domain) {
    const grant = snapshot.grants?.[domain];
    if (grant && grant.levelCapped === false) return true;
  }
  const userRank = SECURITY_LEVEL_RANK[snapshot.maxSecurityLevel];
  const itemRank = SECURITY_LEVEL_RANK[level];
  // 未知密级 fail-closed：查不到 rank 即拒绝
  if (userRank === undefined || itemRank === undefined) return false;
  return itemRank <= userRank;
}

/**
 * 判定数据范围是否覆盖某全宗/机构。
 */
export function canAccessScope(
  snapshot: PermissionSnapshot | null | undefined,
  ref: { fondsId?: string | null; orgId?: string | null; createdBy?: string | null },
): boolean {
  if (!snapshot) return false;
  const { fondsIds, orgIds, selfOnly } = snapshot;
  const unrestricted = fondsIds === null && orgIds === null && !selfOnly;
  if (unrestricted) return true;

  if (fondsIds !== null && ref.fondsId) {
    if (fondsIds.includes(ref.fondsId)) return true;
  }
  if (orgIds !== null && ref.orgId) {
    if (orgIds.includes(ref.orgId)) return true;
  }
  if (selfOnly && ref.createdBy && ref.createdBy === snapshot.userId) return true;
  return false;
}

/**
 * 复合判定：权限 + 密级 + 范围，返回原因（用于前端 title 与后端审计 detail）。
 */
export interface PermissionCheckResult {
  allowed: boolean;
  /** 拒绝原因（中文，直接用于前端 title 提示） */
  reason: string;
}

export function checkPermission(
  snapshot: PermissionSnapshot | null | undefined,
  domain: PermissionDomain,
  op: OperationType,
  ref?: { level?: SecurityLevel; fondsId?: string | null; orgId?: string | null; createdBy?: string | null },
): PermissionCheckResult {
  if (!snapshot) {
    return { allowed: false, reason: '未登录或登录已过期' };
  }
  const grant = snapshot.grants?.[domain];
  if (!grant || grant.mode === PermissionMode.NONE) {
    return { allowed: false, reason: '当前角色无该功能权限' };
  }
  if (!hasPermission(snapshot, domain, op)) {
    if (grant.mode === PermissionMode.READONLY) {
      return { allowed: false, reason: '当前角色仅可查看，不可修改' };
    }
    return { allowed: false, reason: '当前角色无该操作权限' };
  }
  if (ref?.level && !canAccessLevel(snapshot, ref.level, domain)) {
    return { allowed: false, reason: `密级不足（需要 ${snapshot.maxSecurityLevel} 以上）` };
  }
  if ((ref?.fondsId || ref?.orgId || ref?.createdBy) && !canAccessScope(snapshot, ref)) {
    return { allowed: false, reason: '超出授权数据范围（全宗/机构）' };
  }
  return { allowed: true, reason: '' };
}

/** 判断快照是否具备任一角色 */
export function hasRole(
  snapshot: PermissionSnapshot | null | undefined,
  ...roles: RoleCode[]
): boolean {
  if (!snapshot || !Array.isArray(snapshot.roles)) return false;
  if (roles.length === 0) return snapshot.roles.length > 0;
  return roles.some((r) => snapshot.roles.includes(r));
}

/** 是否为管理员角色（R0/R1） */
export function isAdminLike(snapshot: PermissionSnapshot | null | undefined): boolean {
  return hasRole(snapshot, 'R0', 'R1');
}
