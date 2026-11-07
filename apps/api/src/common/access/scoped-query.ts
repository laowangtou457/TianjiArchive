import type { Repository, SelectQueryBuilder } from 'typeorm';
import { SelectQueryBuilder as SQB } from 'typeorm';
import { AccessFilterBuilder } from './access-filter.builder';
import type { SqlAccessFilter } from './access-filter.builder';
import type { PermissionSnapshot } from '@tianji/shared';

/**
 * 将 AccessFilterBuilder 产出的 $n 占位符按 QueryBuilder 现有参数数量重排。
 *
 * TypeORM 的 QueryBuilder 参数名可自定义，这里把 `$1..$n` 重写为 `:acc0..:accN`，
 * 避免与业务参数冲突，也兼容将来切换到达梦/人大金仓（占位符风格差异）。
 */
function rebindParams(
  filter: SqlAccessFilter,
): { clause: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  let counter = 0;
  const clause = filter.clause.replace(/\$(\d+)/g, (_m, num: string) => {
    const value = filter.params[Number.parseInt(num, 10) - 1];
    const key = `acc${counter}`;
    params[key] = value;
    counter += 1;
    return `:${key}`;
  });
  return { clause, params };
}

/**
 * 把行级访问过滤条件应用到 QueryBuilder 上（服务层唯一入口）。
 *
 * 用法：
 *   const qb = repo.createQueryBuilder('i');
 *   applyAccessFilter(qb, builder, user, 'i');
 */
export function applyAccessFilter<T extends object>(
  qb: SelectQueryBuilder<T>,
  builder: AccessFilterBuilder,
  user: PermissionSnapshot,
  alias = 'i',
  options: { includeDeleted?: boolean } = {},
): SelectQueryBuilder<T> {
  const raw = builder.buildSql(user, alias, { includeDeleted: options.includeDeleted });
  const bound = rebindParams(raw);
  return qb.andWhere(bound.clause, bound.params);
}

/**
 * 直接产出 Repository 可用的 where 片段（用于 find/findAndCount 等简易调用）。
 * 注意：复杂条件请使用 applyAccessFilter。
 */
export function accessWhere(builder: AccessFilterBuilder, user: PermissionSnapshot): string {
  const raw = builder.buildSql(user, 'i', {});
  const bound = rebindParams(raw);
  return Object.entries(bound.params).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`:${key}\\b`, 'g'), renderLiteral(value)),
    bound.clause,
  );
}

/** 将参数渲染为内联字面量（仅用于无参数 API 的兜底，值均来自服务端可信数据） */
function renderLiteral(value: unknown): string {
  if (Array.isArray(value)) return `(${value.map((v) => renderLiteral(v)).join(', ')})`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 便捷构造：返回一个新的 SelectQueryBuilder（附带访问过滤） */
export function scopedQuery<T extends object>(
  repo: Repository<T>,
  builder: AccessFilterBuilder,
  user: PermissionSnapshot,
  alias = 'i',
  options: { includeDeleted?: boolean } = {},
): SQB<T> {
  const qb = repo.createQueryBuilder(alias);
  return applyAccessFilter(qb, builder, user, alias, options);
}

export { AccessFilterBuilder };
export type { SqlAccessFilter };
