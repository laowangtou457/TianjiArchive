import { Injectable } from '@nestjs/common';
import {
  SECURITY_LEVEL_RANK,
  SecurityLevel,
  type PermissionSnapshot,
} from '@tianji/shared';

/**
 * 访问过滤器构建器 —— 权限四要素在「数据层」的单点落地。
 *
 * 同一份用户权限快照，同时产出：
 *   1) TypeORM 的 SQL 过滤条件（`buildSql`）—— 条件检索复用；
 *   2) Elasticsearch 的 filter 子句（`buildEsFilter`）—— 全文检索复用；
 *   3) 内存判定（`canAccessRecord`）—— 详情/预览/下载单条校验复用；
 *   4) `/api/kb/*` RAG 检索前的密级前置过滤（`buildKbFilter`）—— P2 复用。
 *
 * 关键约定（架构 §11）：
 *   - 密级过滤恒为 `security_level IN (<= maxLevel)`，用枚举展开而非自定义比较函数，
 *     保证在 ES keyword 字段与 PG varchar 列上行为一致；
 *   - 软删除一律附带 `deleted = FALSE`；
 *   - 数据范围为空集时返回不可能命中的条件（`1=0`），绝不退化为「无过滤」。
 */

/** SQL 过滤条件产物 */
export interface SqlAccessFilter {
  /** 可直接拼进 WHERE 的条件片段（参数化占位符从 $1 开始由调用方按序号重排） */
  clause: string;
  /** 参数值（与条件片段占位符顺序一致） */
  params: unknown[];
}

/** ES filter 子句（数组之间为 AND 关系） */
export interface EsAccessFilter {
  filters: Array<Record<string, unknown>>;
}

@Injectable()
export class AccessFilterBuilder {
  /**
   * 生成 PG 侧的行级过滤条件。
   * @param user  权限快照
   * @param alias 表别名（如 'i' 或 'item'），用于多表联查
   * @param options.startIndex 参数起始序号（配合已有参数使用，默认 1）
   * @param options.includeDeleted 是否包含软删除记录（回收站查询用）
   */
  public buildSql(
    user: PermissionSnapshot,
    alias = 'i',
    options: { startIndex?: number; includeDeleted?: boolean } = {},
  ): SqlAccessFilter {
    const params: unknown[] = [];
    const clauses: string[] = [];
    let idx = options.startIndex ?? 1;
    const col = (name: string): string => `${alias}."${name}"`;

    // -------------------------------------------------------------- 密级
    // 空集合（未知密级 fail-closed）不能拼成 `IN ()`（PG 语法错误），
    // 必须降级为恒假条件，语义 = 完全无权限。
    const levels = this.levelsAtMost(user.maxSecurityLevel);
    if (levels.length === 0) {
      clauses.push('FALSE');
    } else {
      const placeholders = levels.map(() => `$${idx++}`);
      params.push(...levels);
      clauses.push(`${col('security_level')} IN (${placeholders.join(', ')})`);
    }

    // -------------------------------------------------------------- 数据范围
    const scopeClause = this.buildScopeSql(user, alias, params, idx);
    idx = scopeClause.nextIndex;
    if (scopeClause.clause) clauses.push(scopeClause.clause);

    // -------------------------------------------------------------- 软删除
    if (!options.includeDeleted) {
      clauses.push(`${col('deleted')} = FALSE`);
    }

    return { clause: clauses.join(' AND '), params };
  }

  /**
   * 生成 ES 侧的 filter 子句（与 buildSql 语义等价）。
   */
  public buildEsFilter(user: PermissionSnapshot): EsAccessFilter {
    const filters: Array<Record<string, unknown>> = [];

    // 密级：terms 展开保证与 PG 行为一致。
    // 空集合（未知密级 fail-closed）显式用 match_none，避免依赖 ES 对空 terms 的隐式行为。
    const levels = this.levelsAtMost(user.maxSecurityLevel);
    if (levels.length === 0) {
      filters.push({ match_none: {} });
    } else {
      filters.push({ terms: { securityLevel: levels } });
    }

    // 数据范围
    const scopeFilter = this.buildScopeEsFilter(user);
    if (scopeFilter) filters.push(scopeFilter);

    // 软删除
    filters.push({ term: { deleted: false } });

    return { filters };
  }

  /**
   * KB / RAG 检索过滤（密级 + 全宗范围 + 软删除），P0 返回契约，P2 直接复用。
   */
  public buildKbFilter(user: PermissionSnapshot): EsAccessFilter {
    return this.buildEsFilter(user);
  }

  /**
   * 单条记录判定（详情、预览、下载前的兜底校验）。
   * @returns 是否可访问
   */
  public canAccessRecord(
    user: PermissionSnapshot,
    record: {
      securityLevel?: SecurityLevel | null;
      fondsId?: string | null;
      orgId?: string | null;
      createdBy?: string | null;
      deleted?: boolean | null;
    },
    options: { includeDeleted?: boolean } = {},
  ): boolean {
    if (record.deleted === true && !options.includeDeleted) return false;

    // 密级（fail-closed：未知密级值一律拒绝，绝不回落 rank 0 放大权限）
    if (record.securityLevel) {
      const userRank = SECURITY_LEVEL_RANK[user.maxSecurityLevel];
      const recordRank = SECURITY_LEVEL_RANK[record.securityLevel];
      if (userRank === undefined || recordRank === undefined) return false;
      if (recordRank > userRank) return false;
    }

    // 数据范围
    const fondsIds = user.fondsIds;
    const orgIds = user.orgIds;
    const unrestricted = fondsIds === null && orgIds === null && !user.selfOnly;
    if (unrestricted) return true;

    if (fondsIds !== null && record.fondsId && fondsIds.includes(record.fondsId)) {
      // 全宗命中，机构/本人限制仍需放行（全宗授权优先）
      return true;
    }
    if (orgIds !== null && record.orgId && orgIds.includes(record.orgId)) {
      return true;
    }
    if (user.selfOnly && record.createdBy && record.createdBy === user.userId) {
      return true;
    }
    return false;
  }

  /**
   * 返回 <= maxLevel 的密级枚举数组。
   * 未知密级 fail-closed：返回空数组，调用方应视为「无任何可访问密级」。
   */
  public levelsAtMost(max: SecurityLevel): SecurityLevel[] {
    const maxRank = SECURITY_LEVEL_RANK[max];
    if (maxRank === undefined) return [];
    return (Object.keys(SECURITY_LEVEL_RANK) as SecurityLevel[]).filter(
      (l) => SECURITY_LEVEL_RANK[l] <= maxRank,
    );
  }

  // ==========================================================================
  // 内部实现
  // ==========================================================================

  /** 构造 SQL 数据范围条件 */
  private buildScopeSql(
    user: PermissionSnapshot,
    alias: string,
    params: unknown[],
    startIndex: number,
  ): { clause: string; nextIndex: number } {
    const fondsIds = user.fondsIds;
    const orgIds = user.orgIds;
    const unrestricted = fondsIds === null && orgIds === null && !user.selfOnly;
    if (unrestricted) return { clause: '', nextIndex: startIndex };

    let idx = startIndex;
    const parts: string[] = [];
    const fondsCol = `${alias}."fonds_id"`;
    const orgCol = `${alias}."org_id"`;
    const creatorCol = `${alias}."created_by"`;

    if (fondsIds !== null && fondsIds.length > 0) {
      const ph = fondsIds.map(() => `$${idx++}`);
      params.push(...fondsIds);
      parts.push(`${fondsCol} IN (${ph.join(', ')})`);
    }
    if (orgIds !== null && orgIds.length > 0) {
      const ph = orgIds.map(() => `$${idx++}`);
      params.push(...orgIds);
      parts.push(`${orgCol} IN (${ph.join(', ')})`);
    }
    if (user.selfOnly) {
      params.push(user.userId);
      parts.push(`${creatorCol} = $${idx++}`);
    }

    // 授权集合全为空 → 不可能命中，绝不退化为无过滤
    if (parts.length === 0) {
      return { clause: '1 = 0', nextIndex: idx };
    }
    return { clause: `(${parts.join(' OR ')})`, nextIndex: idx };
  }

  /** 构造 ES 数据范围 filter */
  private buildScopeEsFilter(user: PermissionSnapshot): Record<string, unknown> | null {
    const fondsIds = user.fondsIds;
    const orgIds = user.orgIds;
    const unrestricted = fondsIds === null && orgIds === null && !user.selfOnly;
    if (unrestricted) return null;

    const should: Array<Record<string, unknown>> = [];
    if (fondsIds !== null && fondsIds.length > 0) {
      should.push({ terms: { fondsId: fondsIds } });
    }
    if (orgIds !== null && orgIds.length > 0) {
      should.push({ terms: { orgId: orgIds } });
    }
    if (user.selfOnly) {
      should.push({ term: { createdBy: user.userId } });
    }

    if (should.length === 0) {
      // 空集 → 永假条件
      return { term: { _id: '__no_access__' } };
    }
    if (should.length === 1) return should[0];
    return { bool: { should, minimum_should_match: 1 } };
  }
}
