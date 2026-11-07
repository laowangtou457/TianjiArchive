/**
 * AccessFilterBuilder 单元测试（apps/api/src/common/access/access-filter.builder.ts）
 *
 * 这是「权限四要素在数据层的单点落地」，架构 §11 / 验收要点 3 的硬性约束：
 *  ① 密级过滤恒为 security_level IN (<= maxLevel)；
 *  ② 软删除默认附带 deleted = FALSE；
 *  ③ 数据范围为空集时返回永假条件，绝不退化为「无过滤」；
 *  ④ 同一个 user 快照下，SQL / ES / KB / 内存判定四条路径语义一致。
 */
import { describe, expect, it } from 'vitest';
import { AccessFilterBuilder } from '@api/common/access/access-filter.builder';
import type { PermissionSnapshot } from '@tianji/shared';
import { SecurityLevel } from '@tianji/shared';

const builder = new AccessFilterBuilder();

type SnapOverrides = Partial<PermissionSnapshot>;

function snap(over: SnapOverrides = {}): PermissionSnapshot {
  return {
    userId: 'u-1',
    username: 'u1',
    displayName: '用户1',
    roles: ['R1'],
    grants: {},
    maxSecurityLevel: SecurityLevel.INTERNAL,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    ...over,
  };
}

/** 从 ES filter 数组中取出 terms 里的一个字段值集合 */
function esTermsValues(filters: Array<Record<string, unknown>>, field: string): unknown[] | undefined {
  for (const f of filters) {
    const terms = f.terms as Record<string, unknown> | undefined;
    if (terms && field in terms) return terms[field] as unknown[];
  }
  return undefined;
}

// ============================================================================
describe('levelsAtMost —— 密级展开', () => {
  it('PUBLIC 只能取 PUBLIC', () => {
    expect(builder.levelsAtMost(SecurityLevel.PUBLIC)).toEqual(['PUBLIC']);
  });

  it('INTERNAL 可取 PUBLIC + INTERNAL', () => {
    expect(builder.levelsAtMost(SecurityLevel.INTERNAL).sort()).toEqual(['INTERNAL', 'PUBLIC']);
  });

  it('SECRET 可取三档', () => {
    expect(builder.levelsAtMost(SecurityLevel.SECRET).sort()).toEqual([
      'INTERNAL',
      'PUBLIC',
      'SECRET',
    ]);
  });

  it('【回归·缺陷#1 加固】未知密级 → 返回空数组（fail-closed，不回落 PUBLIC）', () => {
    expect(builder.levelsAtMost('TOP_SECRET' as SecurityLevel)).toEqual([]);
    expect(builder.levelsAtMost('' as SecurityLevel)).toEqual([]);
    expect(builder.levelsAtMost(null as unknown as SecurityLevel)).toEqual([]);
  });

  it('未知密级用户生成的 SQL 退化为永假条件（不产生非法空 IN）', () => {
    const { clause, params } = builder.buildSql(
      snap({ maxSecurityLevel: 'TOP_SECRET' as SecurityLevel }),
    );
    // 既不能把未知密级塞进参数（等于放行），也不能生成 `IN ()` 这种语法错误
    expect(params).not.toContain('TOP_SECRET');
    expect(clause).not.toContain('IN ()');
    expect(clause).toContain('FALSE');
    // 仍必须保留软删除条件
    expect(clause).toContain('deleted');
  });
});

// ============================================================================
describe('buildSql —— PG 行级过滤', () => {
  it('全范围用户：仅密级 + 软删除，无范围条件', () => {
    const { clause, params } = builder.buildSql(snap({ maxSecurityLevel: SecurityLevel.SECRET }));
    expect(clause).toContain('i."security_level" IN');
    expect(clause).toContain('i."deleted" = FALSE');
    expect(clause).not.toContain('fonds_id');
    expect(clause).not.toContain('1 = 0');
    expect(params).toEqual(expect.arrayContaining(['PUBLIC', 'INTERNAL', 'SECRET']));
  });

  it('【关键】范围为空集 → 生成 1 = 0 永假条件（绝不退化为无过滤）', () => {
    const { clause } = builder.buildSql(snap({ fondsIds: [], orgIds: [], selfOnly: false }));
    expect(clause).toContain('1 = 0');
    expect(clause).not.toMatch(/fonds_id IN/);
  });

  it('全宗 + 机构 + 本人 → 三者 OR 组合', () => {
    const { clause, params } = builder.buildSql(
      snap({ fondsIds: ['f1', 'f2'], orgIds: ['o1'], selfOnly: true, userId: 'u-9' }),
    );
    expect(clause).toContain('i."fonds_id" IN');
    expect(clause).toContain('i."org_id" IN');
    expect(clause).toContain('i."created_by" =');
    expect(clause).toMatch(/\(.*OR.*OR.*\)/);
    expect(params).toContain('f1');
    expect(params).toContain('o1');
    expect(params).toContain('u-9');
  });

  it('占位符编号连续且与 params 一一对应', () => {
    const { clause, params } = builder.buildSql(
      snap({ maxSecurityLevel: SecurityLevel.SECRET, fondsIds: ['f1'] }),
    );
    const nums = [...clause.matchAll(/\$(\d+)/g)].map((m) => Number.parseInt(m[1], 10));
    expect(nums).toEqual(nums.map((_, i) => i + 1)); // 1..n 连续
    expect(nums.length).toBe(params.length);
  });

  it('startIndex 可从任意位置起编（多参数联查场景）', () => {
    const { clause } = builder.buildSql(snap({ maxSecurityLevel: SecurityLevel.SECRET }), 'i', {
      startIndex: 5,
    });
    expect(clause).toContain('$5');
    expect(clause).not.toContain('$1');
  });

  it('includeDeleted=true 时不附加软删除条件（回收站）', () => {
    const { clause } = builder.buildSql(snap(), 'i', { includeDeleted: true });
    expect(clause).not.toContain('deleted');
  });

  it('alias 生效（多表联查防列名歧义）', () => {
    const { clause } = builder.buildSql(snap(), 'item');
    expect(clause).toContain('item."security_level"');
    expect(clause).not.toContain('i."security_level"');
  });
});

// ============================================================================
describe('buildEsFilter —— ES filter 子句', () => {
  it('包含密级 terms + deleted term', () => {
    const { filters } = builder.buildEsFilter(snap({ maxSecurityLevel: SecurityLevel.PUBLIC }));
    expect(esTermsValues(filters, 'securityLevel')).toEqual(['PUBLIC']);
    expect(filters).toContainEqual({ term: { deleted: false } });
  });

  it('ES mapping 字段名必须与 es.module.ts 一致（securityLevel/fondsId/orgId/createdBy/deleted）', () => {
    const { filters } = builder.buildEsFilter(
      snap({ fondsIds: ['f1'], orgIds: ['o1'], selfOnly: true }),
    );
    const flat = JSON.stringify(filters);
    for (const field of ['securityLevel', 'fondsId', 'orgId', 'createdBy', 'deleted']) {
      expect(flat, `ES filter 缺少 mapping 字段 ${field}`).toContain(field);
    }
    // 不允许出现 snake_case（会命中 dynamic:strict 报错）
    expect(flat).not.toContain('security_level');
  });

  it('范围为空集 → 永假 term（_id 占位），不返回空 filters', () => {
    const { filters } = builder.buildEsFilter(snap({ fondsIds: [], orgIds: [], selfOnly: false }));
    const flat = JSON.stringify(filters);
    expect(flat).toContain('__no_access__');
    // 仍然必须保留密级与软删除条件
    expect(esTermsValues(filters, 'securityLevel')).toBeDefined();
    expect(filters).toContainEqual({ term: { deleted: false } });
  });

  it('多条件范围 → bool.should + minimum_should_match=1', () => {
    const { filters } = builder.buildEsFilter(
      snap({ fondsIds: ['f1'], orgIds: ['o1'], selfOnly: true }),
    );
    const bool = filters.find((f) => f.bool) as { bool: { should: unknown[]; minimum_should_match: number } };
    expect(bool).toBeDefined();
    expect(bool.bool.should.length).toBe(3);
    expect(bool.bool.minimum_should_match).toBe(1);
  });

  it('单条件范围直接返回条件本身（不做多余嵌套）', () => {
    const { filters } = builder.buildEsFilter(snap({ fondsIds: ['f1'] }));
    expect(filters).toContainEqual({ terms: { fondsId: ['f1'] } });
  });
});

// ============================================================================
describe('buildKbFilter —— RAG/KB 与主检索同源', () => {
  const cases: Array<[string, PermissionSnapshot]> = [
    ['全范围', snap({ maxSecurityLevel: SecurityLevel.SECRET })],
    ['单全宗', snap({ fondsIds: ['f1'] })],
    ['全宗+机构+本人', snap({ fondsIds: ['f1'], orgIds: ['o1'], selfOnly: true })],
    ['空集', snap({ fondsIds: [], orgIds: [], selfOnly: false })],
    ['PUBLIC 上限', snap({ maxSecurityLevel: SecurityLevel.PUBLIC })],
  ];

  it.each(cases)('【一致性】%s：KB filter 与 search filter 逐字段相等', (_name, user) => {
    const kb = builder.buildKbFilter(user);
    const search = builder.buildEsFilter(user);
    expect(kb).toEqual(search);
    expect(JSON.stringify(kb.filters)).toBe(JSON.stringify(search.filters));
  });

  it('KB 过滤器同样不会放行 SECRET（INTERNAL 上限）', () => {
    const { filters } = builder.buildKbFilter(snap({ maxSecurityLevel: SecurityLevel.INTERNAL }));
    const levels = esTermsValues(filters, 'securityLevel') as string[];
    expect(levels).not.toContain('SECRET');
  });
});

// ============================================================================
describe('canAccessRecord —— 单条记录内存判定', () => {
  it('密级不足拒绝', () => {
    const user = snap({ maxSecurityLevel: SecurityLevel.INTERNAL });
    expect(builder.canAccessRecord(user, { securityLevel: SecurityLevel.SECRET })).toBe(false);
    expect(builder.canAccessRecord(user, { securityLevel: SecurityLevel.INTERNAL })).toBe(true);
  });

  it('软删除记录默认拒绝，includeDeleted 时放行', () => {
    const user = snap({ maxSecurityLevel: SecurityLevel.PUBLIC });
    expect(builder.canAccessRecord(user, { deleted: true })).toBe(false);
    expect(builder.canAccessRecord(user, { deleted: true }, { includeDeleted: true })).toBe(true);
  });

  it('范围为空集 → 一律拒绝', () => {
    const user = snap({ fondsIds: [], orgIds: [], selfOnly: false });
    expect(builder.canAccessRecord(user, { fondsId: 'f1' })).toBe(false);
  });

  it('全宗命中即放行（与 SQL 的 OR 语义一致）', () => {
    const user = snap({ fondsIds: ['f1'], orgIds: [], selfOnly: false });
    expect(builder.canAccessRecord(user, { fondsId: 'f1' })).toBe(true);
    expect(builder.canAccessRecord(user, { fondsId: 'f2' })).toBe(false);
  });

  it('selfOnly 仅本人创建放行', () => {
    const user = snap({ selfOnly: true, userId: 'u-1' });
    expect(builder.canAccessRecord(user, { createdBy: 'u-1' })).toBe(true);
    expect(builder.canAccessRecord(user, { createdBy: 'u-2' })).toBe(false);
  });
});

// ============================================================================
describe('SQL / ES / 内存 三路径语义一致性（防「一处通一处漏」）', () => {
  const users: Array<[string, PermissionSnapshot]> = [
    ['全范围 SECRET', snap({ maxSecurityLevel: SecurityLevel.SECRET })],
    ['单全宗 INTERNAL', snap({ maxSecurityLevel: SecurityLevel.INTERNAL, fondsIds: ['f1'] })],
    ['空集', snap({ fondsIds: [], orgIds: [], selfOnly: false })],
    ['selfOnly', snap({ selfOnly: true, fondsIds: null, orgIds: null })],
  ];

  it.each(users)('%s：不出现「SQL 有过滤但 ES 没有」的漂移', (_n, user) => {
    const sql = builder.buildSql(user);
    const es = builder.buildEsFilter(user);
    const sqlHasScopeLimit = sql.clause.includes('1 = 0') || sql.clause.includes('fonds_id') || sql.clause.includes('org_id');
    const esHasScopeLimit =
      JSON.stringify(es.filters).includes('__no_access__') ||
      JSON.stringify(es.filters).includes('fondsId') ||
      JSON.stringify(es.filters).includes('orgId');
    expect(esHasScopeLimit).toBe(sqlHasScopeLimit);
    // 密级限制两侧都必须存在
    expect(sql.clause).toContain('security_level');
    expect(JSON.stringify(es.filters)).toContain('securityLevel');
  });
});
