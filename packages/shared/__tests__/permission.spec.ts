/**
 * 权限四要素判定单元测试（packages/shared/src/permission.ts）
 *
 * 四要素：角色 × 数据范围 × 密级 × 操作
 * 重点：SECRET 越权必须拒绝；范围为空集绝不退化为「无过滤」。
 */
import { describe, expect, it } from 'vitest';
import {
  canAccessLevel,
  canAccessScope,
  checkPermission,
  hasPermission,
  hasRole,
  isAdminLike,
  PermissionDomain,
  PermissionMode,
  SecurityLevel,
  type PermissionGrant,
  type PermissionSnapshot,
} from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
const grant = (over: Partial<PermissionGrant> & { domain: PermissionDomain }): PermissionGrant => ({
  ops: ['READ'],
  mode: PermissionMode.FULL,
  ...over,
});

interface SnapshotOverrides extends Partial<Omit<PermissionSnapshot, 'grants'>> {
  grants?: Partial<Record<PermissionDomain, PermissionGrant>>;
}

function snapshot(over: SnapshotOverrides = {}): PermissionSnapshot {
  return {
    userId: 'u-me',
    username: 'me',
    displayName: '我',
    roles: over.roles ?? ['R1'],
    maxSecurityLevel: over.maxSecurityLevel ?? SecurityLevel.INTERNAL,
    scopes: over.scopes ?? [],
    fondsIds: over.fondsIds !== undefined ? over.fondsIds : null,
    orgIds: over.orgIds !== undefined ? over.orgIds : null,
    selfOnly: over.selfOnly ?? false,
    grants: over.grants ?? {
      ITEM: grant({ domain: 'ITEM', ops: ['READ', 'WRITE'], mode: PermissionMode.FULL }),
    },
  };
}

// ============================================================================
describe('hasPermission —— 角色 × 操作', () => {
  it('未登录 / 空快照一律拒绝', () => {
    expect(hasPermission(null, 'ITEM', 'READ')).toBe(false);
    expect(hasPermission(undefined, 'ITEM', 'READ')).toBe(false);
  });

  it('功能域无授权声明 → 拒绝', () => {
    const s = snapshot({ grants: {} });
    expect(hasPermission(s, 'ITEM', 'READ')).toBe(false);
  });

  it('NONE 态即使 ops 声明了权限也拒绝（NONE 一票否决）', () => {
    const s = snapshot({
      grants: { ITEM: grant({ domain: 'ITEM', ops: ['READ'], mode: PermissionMode.NONE }) },
    });
    expect(hasPermission(s, 'ITEM', 'READ')).toBe(false);
  });

  it('READONLY 态仅放行 READ', () => {
    const s = snapshot({
      grants: {
        ITEM: grant({ domain: 'ITEM', ops: ['READ', 'WRITE'], mode: PermissionMode.READONLY }),
      },
    });
    expect(hasPermission(s, 'ITEM', 'READ')).toBe(true);
    expect(hasPermission(s, 'ITEM', 'WRITE')).toBe(false);
    expect(hasPermission(s, 'ITEM', 'DELETE')).toBe(false);
  });

  it('FULL 态以 ops 集合为准', () => {
    const s = snapshot({
      grants: {
        ITEM: grant({ domain: 'ITEM', ops: ['READ', 'WRITE', 'EXPORT'], mode: PermissionMode.FULL }),
      },
    });
    expect(hasPermission(s, 'ITEM', 'WRITE')).toBe(true);
    expect(hasPermission(s, 'ITEM', 'EXPORT')).toBe(true);
    expect(hasPermission(s, 'ITEM', 'APPROVE')).toBe(false);
    expect(hasPermission(s, 'ITEM', 'DELETE')).toBe(false);
  });

  it('LIMITED 态同样以 ops 为准（受限由数据范围/密级另行判定）', () => {
    const s = snapshot({
      grants: { ITEM: grant({ domain: 'ITEM', ops: ['READ'], mode: PermissionMode.LIMITED }) },
    });
    expect(hasPermission(s, 'ITEM', 'READ')).toBe(true);
    expect(hasPermission(s, 'ITEM', 'WRITE')).toBe(false);
  });

  it('跨功能域不串权：ITEM 的授权不能用于 BORROW_APPROVE', () => {
    const s = snapshot({ grants: { ITEM: grant({ domain: 'ITEM', ops: ['READ', 'WRITE'] }) } });
    expect(hasPermission(s, 'BORROW_APPROVE', 'APPROVE')).toBe(false);
  });
});

// ============================================================================
describe('canAccessLevel —— 密级', () => {
  it('密级排序：PUBLIC < INTERNAL < SECRET', () => {
    const publicUser = snapshot({ maxSecurityLevel: SecurityLevel.PUBLIC });
    expect(canAccessLevel(publicUser, SecurityLevel.PUBLIC)).toBe(true);
    expect(canAccessLevel(publicUser, SecurityLevel.INTERNAL)).toBe(false);
    expect(canAccessLevel(publicUser, SecurityLevel.SECRET)).toBe(false);
  });

  it('INTERNAL 用户可取 PUBLIC/INTERNAL，取 SECRET 拒绝', () => {
    const s = snapshot({ maxSecurityLevel: SecurityLevel.INTERNAL });
    expect(canAccessLevel(s, SecurityLevel.PUBLIC)).toBe(true);
    expect(canAccessLevel(s, SecurityLevel.INTERNAL)).toBe(true);
    expect(canAccessLevel(s, SecurityLevel.SECRET)).toBe(false);
  });

  it('SECRET 用户可取全部密级', () => {
    const s = snapshot({ maxSecurityLevel: SecurityLevel.SECRET });
    for (const l of [SecurityLevel.PUBLIC, SecurityLevel.INTERNAL, SecurityLevel.SECRET]) {
      expect(canAccessLevel(s, l)).toBe(true);
    }
  });

  it('功能域显式声明 levelCapped=false → 不受密级限制（系统统计场景）', () => {
    const s = snapshot({
      maxSecurityLevel: SecurityLevel.PUBLIC,
      grants: {
        ITEM: grant({ domain: 'ITEM', levelCapped: false }),
      },
    });
    expect(canAccessLevel(s, SecurityLevel.SECRET, 'ITEM')).toBe(true);
  });

  it('未登录拒绝', () => {
    expect(canAccessLevel(null, SecurityLevel.PUBLIC)).toBe(false);
  });

  it('未知密级值按 rank 0 处理（不放大权限）', () => {
    const s = snapshot({ maxSecurityLevel: SecurityLevel.PUBLIC });
    expect(canAccessLevel(s, 'TOP_SECRET' as SecurityLevel)).toBe(false);
  });
});

// ============================================================================
describe('canAccessScope —— 数据范围', () => {
  it('全部范围（fondsIds/orgIds 均为 null 且非 selfOnly）→ 放行任意记录', () => {
    const s = snapshot({ fondsIds: null, orgIds: null, selfOnly: false });
    expect(canAccessScope(s, { fondsId: 'any', orgId: 'any' })).toBe(true);
    expect(canAccessScope(s, {})).toBe(true);
  });

  it('全宗白名单命中 → 放行；未命中 → 拒绝', () => {
    const s = snapshot({ fondsIds: ['f1'], orgIds: null, selfOnly: false });
    expect(canAccessScope(s, { fondsId: 'f1' })).toBe(true);
    expect(canAccessScope(s, { fondsId: 'f2' })).toBe(false);
  });

  it('机构白名单命中 → 放行', () => {
    const s = snapshot({ fondsIds: null, orgIds: ['o1'], selfOnly: false });
    expect(canAccessScope(s, { orgId: 'o1' })).toBe(true);
    expect(canAccessScope(s, { orgId: 'o2' })).toBe(false);
  });

  it('selfOnly 仅本人创建可见', () => {
    const s = snapshot({ fondsIds: null, orgIds: null, selfOnly: true, userId: 'u-me' });
    expect(canAccessScope(s, { createdBy: 'u-me' })).toBe(true);
    expect(canAccessScope(s, { createdBy: 'u-other' })).toBe(false);
    expect(canAccessScope(s, {})).toBe(false);
  });

  it('范围为空集（fondsIds=[] 且 orgIds=[]）→ 一律拒绝，绝不退化为全放行', () => {
    const s = snapshot({ fondsIds: [], orgIds: [], selfOnly: false });
    expect(canAccessScope(s, { fondsId: 'f1' })).toBe(false);
    expect(canAccessScope(s, { orgId: 'o1' })).toBe(false);
    expect(canAccessScope(s, {})).toBe(false);
  });
});

// ============================================================================
describe('checkPermission —— 四要素复合矩阵', () => {
  const base = snapshot({
    maxSecurityLevel: SecurityLevel.INTERNAL,
    fondsIds: ['f1'],
    orgIds: null,
    selfOnly: false,
    grants: { ITEM: grant({ domain: 'ITEM', ops: ['READ', 'WRITE'] }) },
  });

  it('四要素全通过 → allowed', () => {
    const r = checkPermission(base, 'ITEM', 'WRITE', { level: SecurityLevel.INTERNAL, fondsId: 'f1' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('');
  });

  it('未登录 → 拒绝且提示登录', () => {
    const r = checkPermission(null, 'ITEM', 'READ');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('未登录');
  });

  it('无功能域权限 → 拒绝', () => {
    const r = checkPermission(base, 'BORROW_APPROVE', 'APPROVE');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('无该功能权限');
  });

  it('只读态试图写 → 拒绝且给出只读原因', () => {
    const s = snapshot({
      grants: { ITEM: grant({ domain: 'ITEM', ops: ['READ'], mode: PermissionMode.READONLY }) },
    });
    const r = checkPermission(s, 'ITEM', 'WRITE');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('仅可查看');
  });

  it('【关键】SECRET 越权：INTERNAL 用户访问 SECRET 档案 → 拒绝', () => {
    const r = checkPermission(base, 'ITEM', 'READ', {
      level: SecurityLevel.SECRET,
      fondsId: 'f1',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('密级不足');
  });

  it('【关键】即便有权限、在范围内，密级不足也必须拒绝（密级独立生效）', () => {
    const s = snapshot({
      maxSecurityLevel: SecurityLevel.PUBLIC,
      fondsIds: null,
      orgIds: null,
      grants: { ITEM: grant({ domain: 'ITEM', ops: ['READ', 'WRITE', 'DELETE', 'APPROVE', 'EXPORT'] }) },
    });
    for (const op of ['READ', 'WRITE', 'DELETE', 'APPROVE', 'EXPORT'] as const) {
      const r = checkPermission(s, 'ITEM', op, { level: SecurityLevel.SECRET });
      expect(r.allowed, `操作 ${op} 不应被放行`).toBe(false);
    }
  });

  it('数据范围越权 → 拒绝', () => {
    const r = checkPermission(base, 'ITEM', 'READ', {
      level: SecurityLevel.PUBLIC,
      fondsId: 'f-outside',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('超出授权数据范围');
  });

  it('不传 ref → 仅判定功能权限（用于列表级粗判）', () => {
    expect(checkPermission(base, 'ITEM', 'READ').allowed).toBe(true);
  });
});

// ============================================================================
describe('角色判定', () => {
  it('hasRole 命中任一即 true；空参数表示「有任意角色」', () => {
    const s = snapshot({ roles: ['R1', 'R3'] });
    expect(hasRole(s, 'R1')).toBe(true);
    expect(hasRole(s, 'R0')).toBe(false);
    expect(hasRole(s, 'R0', 'R3')).toBe(true);
    expect(hasRole(s)).toBe(true);
    expect(hasRole(null, 'R1')).toBe(false);
  });

  it('isAdminLike 覆盖 R0 与 R1', () => {
    expect(isAdminLike(snapshot({ roles: ['R0'] }))).toBe(true);
    expect(isAdminLike(snapshot({ roles: ['R1'] }))).toBe(true);
    expect(isAdminLike(snapshot({ roles: ['R3'] }))).toBe(false);
  });
});
