import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { In, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  ITEM_STATUS_VALUES,
  PAGE_SIZE_OPTIONS,
  RETENTION_LABELS,
  Retention,
  SECURITY_LEVEL_LABELS,
  SecurityLevel,
  type ConditionalSearchQuery,
  type FacetBucket,
  type FulltextSearchQuery,
  type FulltextSearchResult,
  type PageResult,
  type PermissionSnapshot,
  type SearchFacets,
  type SearchHit,
} from '@tianji/shared';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { SearchHistory } from '../../infra/database/entities/search-history.entity';
import { EsService } from '../../infra/elasticsearch/es.module';
import { EsIndexerService } from '../../infra/elasticsearch/es-indexer.service';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { applyAccessFilter } from '../../common/access/scoped-query';
import { RedisService } from '../../infra/redis/redis.module';
import { SynonymService } from './synonym.service';

/** ES 聚合返回桶 */
interface EsBucket {
  key: string;
  doc_count: number;
}

/** ES 命中项 */
interface EsHit {
  _id: string;
  _score: number | null;
  _source: Record<string, unknown>;
  highlight?: Record<string, string[]>;
}

/**
 * 检索服务（F-05，DA/T 18-2022 §8 检索点）。
 *
 * 两条路径：
 *  1) 全文检索（ES）：IK 分词 + 高亮 + 分面聚合，P95<2s；
 *  2) 条件检索（PG）：复合索引覆盖，P95<1s。
 *
 * 权限：两条路径均通过同一个 AccessFilterBuilder 注入密级与数据范围过滤，
 *      保证「无权限条目不出现」（硬性验收要点 3）。
 * 降级：ES 不可用时全文检索自动回落到 PG 的 ILIKE/tsvector，保证可用性。
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(ElectronicFile) private readonly fileRepo: Repository<ElectronicFile>,
    @InjectRepository(SearchHistory) private readonly historyRepo: Repository<SearchHistory>,
    private readonly es: EsService,
    private readonly accessBuilder: AccessFilterBuilder,
    private readonly esIndexer: EsIndexerService,
    private readonly synonyms: SynonymService,
    private readonly redis: RedisService,
  ) {}

  // ==========================================================================
  // 全文检索（ES）
  // ==========================================================================

  public async fulltext(
    query: FulltextSearchQuery,
    user: PermissionSnapshot,
  ): Promise<FulltextSearchResult> {
    const startedAt = Date.now();
    const page = Math.max(1, query.page ?? 1);
    const size = PAGE_SIZE_OPTIONS.includes(query.size ?? 20) ? (query.size as number) : 20;

    // ---- 结果缓存 ----
    // 缓存只覆盖「ES 成功路径」：PG 降级本身已经是毫秒级，缓存它反而让降级状态被掩盖。
    // key 里带权限指纹与索引版本号：换人、换权限、条目变更后自动落到新 key，
    // 不需要 SCAN 删旧键，旧键靠 TTL 自然淘汰。
    const cacheKey = await this.buildCacheKey(query, user, page, size);
    const cached = await this.redis.getJson<FulltextSearchResult>(cacheKey);
    if (cached) {
      // 命中缓存也必须留痕：「我的检索历史」与审计不能因为缓存出现空洞
      void this.recordHistory(user.userId, query.q ?? '', query as unknown as Record<string, unknown>, cached.total, Date.now() - startedAt);
      return { ...cached, took: Date.now() - startedAt };
    }

    let result: FulltextSearchResult;
    let viaEs = false;
    try {
      result = await this.fulltextViaEs(query, user, page, size);
      viaEs = true;
    } catch (err) {
      this.logger.warn(`ES 检索失败，降级 PG 全文: ${(err as Error).message}`);
      result = await this.fulltextViaPg(query, user, page, size);
    }

    if (viaEs) await this.redis.setJson(cacheKey, result, SearchService.CACHE_TTL_SECONDS);

    // 检索历史异步写：它只影响「最近检索」列表，不该拖慢检索响应
    void this.recordHistory(user.userId, query.q ?? '', query as unknown as Record<string, unknown>, result.total, result.took);
    return result;
  }

  /** 检索结果缓存时长：与 ES refresh_interval(30s) 对齐，避免「缓存比索引还新」的错觉 */
  private static readonly CACHE_TTL_SECONDS = 30;

  /**
   * 缓存键 = 权限指纹 + 归一化查询 + 索引版本。
   *
   * 权限指纹必须包含密级上限与数据范围：同一个查询串在不同权限下结果集不同，
   * 若只按查询串做键，低密级用户会命中高密级用户的缓存 —— 越权。
   */
  private async buildCacheKey(
    query: FulltextSearchQuery,
    user: PermissionSnapshot,
    page: number,
    size: number,
  ): Promise<string> {
    const ver = (await this.redis.get('tj:search:ver')) ?? '0';
    const fp = [
      user.userId,
      user.maxSecurityLevel,
      user.selfOnly ? 'self' : 'all',
      [...(user.fondsIds ?? ['*'])].sort().join(','),
      [...(user.orgIds ?? ['*'])].sort().join(','),
    ].join('|');
    const payload = JSON.stringify({
      q: query.q ?? '',
      fonds: query.fonds ?? [],
      category: query.category ?? [],
      status: query.status ?? [],
      level: query.level ?? [],
      retention: query.retention ?? [],
      openFlag: query.openFlag ?? [],
      yearFrom: query.yearFrom ?? null,
      yearTo: query.yearTo ?? null,
      sort: query.sort ?? 'relevance',
      page,
      size,
    });
    const hash = createHash('sha1').update(`${fp}#${payload}`).digest('hex').slice(0, 24);
    return `tj:search:v${ver}:${hash}`;
  }

  private async fulltextViaEs(
    query: FulltextSearchQuery,
    user: PermissionSnapshot,
    page: number,
    size: number,
  ): Promise<FulltextSearchResult> {
    const startedAt = Date.now();
    const { filters } = this.accessBuilder.buildEsFilter(user);

    const must: Array<Record<string, unknown>> = [];
    const filter: Array<Record<string, unknown>> = [...filters];
    const should: Array<Record<string, unknown>> = [];

    const q = (query.q ?? '').trim();
    let expansions: string[] = [];
    if (q) {
      const fields = ['title^3', 'keywords^2', 'responsible^2', 'docNo^1.5', 'note', 'fulltext'];
      // 同义词扩展：原词权重 1.0，扩展词 0.55 —— 扩展只用来兜召回，
      // 不能把「原词精确命中」的结果挤到同义词命中之后。
      expansions = await this.synonyms.expand(q);
      if (expansions.length === 0) {
        must.push({ multi_match: { query: q, fields, type: 'best_fields', operator: 'or' } });
      } else {
        must.push({
          bool: {
            should: [
              { multi_match: { query: q, fields, type: 'best_fields', operator: 'or', boost: 1.0 } },
              ...expansions.map((term) => ({
                multi_match: { query: term, fields, type: 'best_fields', operator: 'or', boost: 0.55 },
              })),
            ],
            minimum_should_match: 1,
          },
        });
      }
      // 档号精确/前缀匹配（提升排序）
      should.push({ term: { danghao: { value: q, boost: 5 } } });
      should.push({ prefix: { danghao: { value: q, boost: 2 } } });
    }

    // 显式条件（作为 filter，保证不参与打分）
    if (query.fonds && query.fonds.length > 0) filter.push({ terms: { fondsId: query.fonds } });
    if (query.category && query.category.length > 0) {
      filter.push({ terms: { categoryCode: query.category } });
    }
    if (query.status && query.status.length > 0) filter.push({ terms: { status: query.status } });
    if (query.level && query.level.length > 0) {
      // 注意：用户勾选的密级只能是自己可访问范围的子集
      const allowed = this.accessBuilder.levelsAtMost(user.maxSecurityLevel);
      const effective = query.level.filter((l) => allowed.includes(l));
      if (effective.length === 0) {
        return this.emptyResult(query, startedAt);
      }
      filter.push({ terms: { securityLevel: effective } });
    }
    if (query.retention && query.retention.length > 0) {
      filter.push({ terms: { retention: query.retention } });
    }
    if (query.openFlag && query.openFlag.length > 0) {
      filter.push({ terms: { openFlag: query.openFlag } });
    }
    if (query.yearFrom || query.yearTo) {
      filter.push({
        range: {
          year: {
            ...(query.yearFrom ? { gte: query.yearFrom } : {}),
            ...(query.yearTo ? { lte: query.yearTo } : {}),
          },
        },
      });
    }

    const sort =
      query.sort === 'dateDesc'
        ? [{ docDate: { order: 'desc', missing: '_last' } }]
        : query.sort === 'dateAsc'
          ? [{ docDate: { order: 'asc', missing: '_last' } }]
          : query.sort === 'danghaoAsc'
            ? [{ 'danghao.keyword': { order: 'asc' } }]
            : q
              ? ['_score', { docDate: { order: 'desc', missing: '_last' } }]
              : [{ docDate: { order: 'desc', missing: '_last' } }];

    const body = {
      from: (page - 1) * size,
      size,
      // 上限 10000：超过后 ES 只给出「≥10000」而不再精确计数，省掉一次全库计数扫描；
      // 档案检索的用途是「有没有、大概多少」，不需要精确到个位
      track_total_hits: 10000,
      // 注意：request_cache 在 ES 8 是顶层请求参数而非 body 字段，
      // 写进 body 会直接 parsing_exception（曾导致全部检索静默降级 PG）
      query: {
        bool: {
          must,
          filter,
          should,
          minimum_should_match: should.length > 0 && must.length > 0 ? 0 : should.length > 0 ? 1 : 0,
        },
      },
      sort,
      highlight: {
        pre_tags: ['<em class="hl">'],
        post_tags: ['</em>'],
        fields: {
          title: { number_of_fragments: 0 },
          responsible: { number_of_fragments: 0 },
          keywords: { number_of_fragments: 0 },
          fulltext: { fragment_size: 150, number_of_fragments: 2 },
          note: { fragment_size: 150, number_of_fragments: 1 },
        },
      },
      aggs: {
        fonds: { terms: { field: 'fondsId', size: 20 } },
        year: { terms: { field: 'year', size: 30, order: { _key: 'desc' } } },
        retention: { terms: { field: 'retention', size: 10 } },
        level: { terms: { field: 'securityLevel', size: 10 } },
        category: { terms: { field: 'categoryCode', size: 20 } },
      },
    };

    // 说明：ES 客户端类型对 aggs/sort 的结构要求比运行时严格，
    // 这里把请求体视为已构造正确的 SearchRequest（字段名与官方 DSL 完全一致）。
    const request = {
      index: this.es.index,
      body,
      // 分片级请求缓存：同一查询体（含权限过滤）在多用户/多页间复用结果
      request_cache: true,
    } as unknown as Parameters<typeof this.es.client.search>[0];
    const raw = (await this.es.client.search(request)) as unknown as {
      took: number;
      hits: { total: { value: number } | number; hits: EsHit[] };
      aggregations?: Record<string, { buckets: EsBucket[] }>;
    };

    const total =
      typeof raw.hits.total === 'number' ? raw.hits.total : (raw.hits.total?.value ?? 0);
    const hits = raw.hits.hits ?? [];
    const fondsIdSet = Array.from(new Set(hits.map((h) => String(h._source.fondsId ?? ''))));
    const fondsNameMap = await this.loadFondsNames(fondsIdSet);

    const list: SearchHit[] = hits.map((h) => this.toHit(h, fondsNameMap));
    // 分面桶覆盖的是「全部命中」而非当前页，因此要按桶的 key 单独换名，
    // 否则左侧过滤栏会把 UUID 直接甩给用户
    const facetFondsIds = (raw.aggregations?.fonds?.buckets ?? []).map((b) => String(b.key));
    const facetFondsNames = await this.loadFondsNames(facetFondsIds);
    const facets = this.buildFacets(raw.aggregations, facetFondsNames);

    return {
      list,
      total,
      page,
      size,
      took: Date.now() - startedAt,
      facets,
      echo: query as unknown as Record<string, unknown>,
      expanded: expansions,
    };
  }

  /** ES 不可用时的 PG 降级全文检索 */
  private async fulltextViaPg(
    query: FulltextSearchQuery,
    user: PermissionSnapshot,
    page: number,
    size: number,
  ): Promise<FulltextSearchResult> {
    const startedAt = Date.now();
    const qb = this.itemRepo.createQueryBuilder('i');
    applyAccessFilter(qb, this.accessBuilder, user, 'i');

    const q = (query.q ?? '').trim();
    let pgExpansions: string[] = [];
    if (q) {
      // 降级路径同样走同义词扩展，否则 ES 一挂「同义词」就静默失效，行为不一致
      pgExpansions = await this.synonyms.expand(q);
      const terms = [q, ...pgExpansions];
      const params: Record<string, unknown> = {};
      const groups = terms.map((t, i) => {
        params[`kw${i}`] = `%${t}%`;
        params[`tq${i}`] = t;
        return `(i.title ILIKE :kw${i} OR i.responsible ILIKE :kw${i} OR i.docNo ILIKE :kw${i}
          OR i.danghao ILIKE :kw${i} OR i.note ILIKE :kw${i} OR i.fullText ILIKE :kw${i}
          OR to_tsvector('simple', coalesce(i.title,'') || ' ' || coalesce(i.fullText,'')) @@ plainto_tsquery('simple', :tq${i}))`;
      });
      qb.andWhere(`(${groups.join(' OR ')})`, params);
    }
    if (query.fonds && query.fonds.length > 0) {
      qb.andWhere('i.fondsId IN (:...fonds)', { fonds: query.fonds });
    }
    if (query.category && query.category.length > 0) {
      qb.andWhere('i.categoryCode IN (:...cats)', { cats: query.category });
    }
    if (query.status && query.status.length > 0) {
      qb.andWhere('i.status IN (:...statuses)', { statuses: query.status });
    }
    if (query.level && query.level.length > 0) {
      const allowed = this.accessBuilder.levelsAtMost(user.maxSecurityLevel);
      const effective = query.level.filter((l) => allowed.includes(l));
      qb.andWhere('i.securityLevel IN (:...levels)', { levels: effective.length > 0 ? effective : ['__none__'] });
    }
    if (query.retention && query.retention.length > 0) {
      qb.andWhere('i.retention IN (:...rets)', { rets: query.retention });
    }
    if (query.yearFrom) qb.andWhere('i.year >= :yf', { yf: query.yearFrom });
    if (query.yearTo) qb.andWhere('i.year <= :yt', { yt: query.yearTo });

    qb.orderBy('i.docDate', 'DESC', 'NULLS LAST').addOrderBy('i.danghao', 'ASC');
    qb.skip((page - 1) * size).take(size);

    const [rows, total] = await qb.getManyAndCount();
    const fileCounts = await this.countFiles(rows.map((r) => r.id));
    const fondsNameMap = await this.loadFondsNames(Array.from(new Set(rows.map((r) => r.fondsId))));

    const list: SearchHit[] = rows.map((r) => ({
      id: r.id,
      danghao: r.danghao,
      title: r.title,
      responsible: r.responsible,
      year: r.year,
      retention: r.retention,
      securityLevel: r.securityLevel,
      categoryCode: r.categoryCode,
      docDate: r.docDate,
      fondsId: r.fondsId,
      status: r.status,
      openFlag: r.openFlag,
      score: null,
      highlights: q ? this.buildPgHighlights(r, q) : [],
      fileCount: fileCounts.get(r.id) ?? 0,
      hasPreview: (fileCounts.get(r.id) ?? 0) > 0,
    }));

    // 降级模式的分面：基于结果集统计
    const facets: SearchFacets = {
      fonds: this.countFacet(rows.map((r) => r.fondsId), fondsNameMap),
      year: this.countFacet(rows.map((r) => String(r.year))),
      retention: this.countFacet(rows.map((r) => r.retention), RETENTION_LABELS),
      securityLevel: this.countFacet(rows.map((r) => r.securityLevel), SECURITY_LEVEL_LABELS),
      category: this.countFacet(rows.map((r) => r.categoryCode ?? '未分类')),
    };

    return {
      list,
      total,
      page,
      size,
      took: Date.now() - startedAt,
      facets,
      echo: query as unknown as Record<string, unknown>,
      expanded: pgExpansions,
    };
  }

  // ==========================================================================
  // 条件检索（PG）
  // ==========================================================================

  /** 允许条件检索的字段白名单（防注入与越权字段） */
  private static readonly CONDITION_FIELDS: Record<string, { column: string; type: 'string' | 'number' | 'date' | 'array' | 'enum' }> = {
    danghao: { column: 'danghao', type: 'string' },
    title: { column: 'title', type: 'string' },
    responsible: { column: 'responsible', type: 'string' },
    docNo: { column: 'doc_no', type: 'string' },
    docDate: { column: 'doc_date', type: 'date' },
    year: { column: 'year', type: 'number' },
    retention: { column: 'retention', type: 'enum' },
    securityLevel: { column: 'security_level', type: 'enum' },
    categoryCode: { column: 'category_code', type: 'string' },
    classNo: { column: 'class_no', type: 'string' },
    keywords: { column: 'keywords', type: 'array' },
    pages: { column: 'pages', type: 'number' },
    note: { column: 'note', type: 'string' },
    status: { column: 'status', type: 'enum' },
    openFlag: { column: 'open_flag', type: 'enum' },
    fondsId: { column: 'fonds_id', type: 'string' },
    volumeId: { column: 'volume_id', type: 'string' },
  };

  public async conditional(
    query: ConditionalSearchQuery,
    user: PermissionSnapshot,
  ): Promise<PageResult<SearchHit> & { took: number }> {
    const startedAt = Date.now();
    const page = Math.max(1, query.page ?? 1);
    const size = PAGE_SIZE_OPTIONS.includes(query.size ?? 20) ? (query.size as number) : 20;

    const qb = this.itemRepo.createQueryBuilder('i');
    applyAccessFilter(qb, this.accessBuilder, user, 'i');

    const conditions: Array<{ clause: string; params: Record<string, unknown> }> = [];
    const filters = query.filters ?? [];
    let paramIdx = 0;

    for (const f of filters) {
      const def = SearchService.CONDITION_FIELDS[f.field];
      if (!def) {
        throw new BizException(ErrorCode.BAD_REQUEST, `不支持的检索字段：${f.field}`);
      }
      const p = `c${paramIdx++}`;
      const col = `i."${def.column}"`;
      switch (f.operator) {
        case 'eq':
          conditions.push({ clause: `${col} = :${p}`, params: { [p]: f.value } });
          break;
        case 'ne':
          conditions.push({ clause: `${col} <> :${p}`, params: { [p]: f.value } });
          break;
        case 'in': {
          const list = Array.isArray(f.value) ? f.value : [f.value];
          if (list.length === 0) break;
          conditions.push({ clause: `${col} IN (:...${p})`, params: { [p]: list } });
          break;
        }
        case 'like':
          conditions.push({ clause: `${col} ILIKE :${p}`, params: { [p]: `%${String(f.value ?? '')}%` } });
          break;
        case 'gte':
          conditions.push({ clause: `${col} >= :${p}`, params: { [p]: f.value } });
          break;
        case 'lte':
          conditions.push({ clause: `${col} <= :${p}`, params: { [p]: f.value } });
          break;
        case 'between': {
          const arr = Array.isArray(f.value) ? f.value : [];
          if (arr.length !== 2) {
            throw new BizException(ErrorCode.BAD_REQUEST, `字段 ${f.field} 的 between 需要两个值`);
          }
          conditions.push({
            clause: `${col} BETWEEN :${p}a AND :${p}b`,
            params: { [`${p}a`]: arr[0], [`${p}b`]: arr[1] },
          });
          break;
        }
        case 'isNull':
          conditions.push({ clause: `${col} IS NULL`, params: {} });
          break;
        case 'notNull':
          conditions.push({ clause: `${col} IS NOT NULL`, params: {} });
          break;
        default:
          throw new BizException(ErrorCode.BAD_REQUEST, `不支持的运算符：${String(f.operator)}`);
      }
    }

    if (conditions.length > 0) {
      const join = query.logic === 'OR' ? ' OR ' : ' AND ';
      const clause = conditions.map((c) => `(${c.clause})`).join(join);
      const params = conditions.reduce<Record<string, unknown>>((acc, c) => ({ ...acc, ...c.params }), {});
      qb.andWhere(`(${clause})`, params);
    }

    // 排序（白名单）
    const sortBy = query.sortBy && SearchService.CONDITION_FIELDS[query.sortBy]
      ? `i."${SearchService.CONDITION_FIELDS[query.sortBy].column}"`
      : 'i."created_at"';
    qb.orderBy(sortBy, query.sortOrder === 'ASC' ? 'ASC' : 'DESC').addOrderBy('i."danghao"', 'ASC');

    qb.skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();
    const fileCounts = await this.countFiles(rows.map((r) => r.id));

    return {
      list: rows.map((r) => ({
        id: r.id,
        danghao: r.danghao,
        title: r.title,
        responsible: r.responsible,
        year: r.year,
        retention: r.retention,
        securityLevel: r.securityLevel,
        categoryCode: r.categoryCode,
        docDate: r.docDate,
        fondsId: r.fondsId,
        status: r.status,
        openFlag: r.openFlag,
        score: null,
        highlights: [],
        fileCount: fileCounts.get(r.id) ?? 0,
        hasPreview: (fileCounts.get(r.id) ?? 0) > 0,
      })),
      total,
      page,
      size,
      took: Date.now() - startedAt,
    };
  }

  // ==========================================================================
  // 检索历史
  // ==========================================================================

  public async history(userId: string, limit = 20): Promise<Array<{ keyword: string; createdAt: string }>> {
    const rows = await this.historyRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 50),
    });
    const seen = new Set<string>();
    const out: Array<{ keyword: string; createdAt: string }> = [];
    for (const r of rows) {
      const kw = r.keyword ?? '';
      if (!kw || seen.has(kw)) continue;
      seen.add(kw);
      out.push({ keyword: kw, createdAt: new Date(r.createdAt).toISOString() });
      if (out.length >= limit) break;
    }
    return out;
  }

  private async recordHistory(
    userId: string,
    keyword: string,
    query: Record<string, unknown>,
    count: number,
    took: number,
  ): Promise<void> {
    try {
      const row = this.historyRepo.create({
        userId,
        keyword: keyword ? keyword.slice(0, 500) : null,
        query,
        resultCount: count,
        tookMs: took,
      });
      await this.historyRepo.save(row);
    } catch (err) {
      this.logger.warn(`检索历史写入失败: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // ES 索引写入（由 Archive 变更与 Extractor 调用）
  // ==========================================================================

  /** 将条目（含全文）同步到 ES —— 委托 infra 层索引器（单一实现） */
  public async syncItemToEs(itemId: string, _fulltext?: string): Promise<void> {
    await this.esIndexer.syncItem(itemId);
  }

  /** 批量重建索引（运维/迁移后调用） */
  public async reindexAll(batchSize = 500): Promise<{ indexed: number }> {
    return this.esIndexer.reindexAll(batchSize, true);
  }

  // ==========================================================================
  // 辅助
  // ==========================================================================

  private async loadFondsNames(fondsIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (fondsIds.length === 0) return map;
    const rows = await this.fondsRepo.find({ where: { id: In(fondsIds) } });
    for (const r of rows) map.set(r.id, `${r.fondsNo} ${r.name}`);
    return map;
  }

  private async countFiles(itemIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (itemIds.length === 0) return map;
    const rows: Array<{ item_id: string; cnt: string }> = await this.fileRepo.query(
      `SELECT item_id, COUNT(*)::text AS cnt FROM electronic_file WHERE item_id = ANY($1::uuid[]) GROUP BY item_id`,
      [itemIds],
    );
    for (const r of rows) map.set(r.item_id, Number.parseInt(r.cnt, 10));
    return map;
  }

  private toHit(h: EsHit, _fondsNameMap: Map<string, string>): SearchHit {
    const s = h._source;
    const highlights = Object.entries(h.highlight ?? {}).map(([field, fragments]) => ({
      field,
      fragments,
    }));
    return {
      id: String(s.id ?? h._id),
      danghao: String(s.danghao ?? ''),
      title: String(s.title ?? ''),
      responsible: (s.responsible as string | null) ?? null,
      year: Number(s.year ?? 0),
      retention: (s.retention as Retention) ?? ('PERM' as Retention),
      securityLevel: (s.securityLevel as SecurityLevel) ?? ('PUBLIC' as SecurityLevel),
      categoryCode: (s.categoryCode as string | null) ?? null,
      docDate: (s.docDate as string | null) ?? null,
      fondsId: String(s.fondsId ?? ''),
      status: (s.status as SearchHit['status']) ?? 'DRAFT',
      openFlag: (s.openFlag as SearchHit['openFlag']) ?? 'CONTROLLED',
      score: h._score ?? null,
      highlights,
      fileCount: Number(s.fileCount ?? 0),
      hasPreview: Boolean(s.hasPreview),
    };
  }

  private buildFacets(
    aggs?: Record<string, { buckets: EsBucket[] }>,
    fondsNames?: Map<string, string>,
  ): SearchFacets {
    const toBuckets = (
      buckets: EsBucket[] = [],
      labelMap?: Record<string, string> | Map<string, string>,
    ): FacetBucket[] =>
      buckets.map((b) => ({
        key: String(b.key),
        label: this.labelOf(labelMap, String(b.key)),
        count: b.doc_count,
      }));

    return {
      fonds: toBuckets(aggs?.fonds?.buckets, fondsNames),
      year: toBuckets(aggs?.year?.buckets),
      retention: toBuckets(aggs?.retention?.buckets, RETENTION_LABELS),
      securityLevel: toBuckets(aggs?.level?.buckets, SECURITY_LEVEL_LABELS),
      category: toBuckets(aggs?.category?.buckets),
    };
  }

  /** 分面标签解析：支持普通映射与 Map（全宗名用 Map 传，避免构造大对象） */
  private labelOf(labelMap: Record<string, string> | Map<string, string> | undefined, key: string): string {
    if (!labelMap) return key;
    if (labelMap instanceof Map) return labelMap.get(key) ?? key;
    return labelMap[key] ?? key;
  }

  private countFacet(
    values: string[],
    labelMap?: Record<string, string> | Map<string, string>,
  ): FacetBucket[] {
    const labelOf = (key: string): string => this.labelOf(labelMap, key);
    const counter = new Map<string, number>();
    for (const v of values) {
      if (!v) continue;
      counter.set(v, (counter.get(v) ?? 0) + 1);
    }
    return Array.from(counter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([key, count]) => ({ key, label: labelOf(key), count }));
  }

  /** PG 降级模式的高亮片段（关键词前后各截 60 字） */
  private buildPgHighlights(item: ArchiveItem, q: string): Array<{ field: string; fragments: string[] }> {
    const out: Array<{ field: string; fragments: string[] }> = [];
    const mark = (text: string | null | undefined, re: RegExp): string | null => {
      if (!text) return null;
      const idx = text.search(re);
      if (idx < 0) return null;
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + 90);
      return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(re, (m) => `<em class="hl">${m}</em>`)}${end < text.length ? '…' : ''}`;
    };
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');

    const title = mark(item.title, re);
    if (title) out.push({ field: 'title', fragments: [title] });
    const resp = mark(item.responsible, re);
    if (resp) out.push({ field: 'responsible', fragments: [resp] });
    const full = mark(item.fullText, re);
    if (full) out.push({ field: 'fulltext', fragments: [full] });
    const note = mark(item.note, re);
    if (note) out.push({ field: 'note', fragments: [note] });
    return out;
  }

  private emptyResult(query: FulltextSearchQuery, startedAt: number): FulltextSearchResult {
    return {
      list: [],
      total: 0,
      page: query.page ?? 1,
      size: query.size ?? 20,
      took: Date.now() - startedAt,
      facets: { fonds: [], year: [], retention: [], securityLevel: [], category: [] },
      echo: query as unknown as Record<string, unknown>,
      expanded: [],
    };
  }

  /** 校验查询参数（供 Controller 提前拦截非法值） */
  public assertQueryValid(query: FulltextSearchQuery): void {
    if (query.level) {
      const invalid = query.level.filter((l) => !['PUBLIC', 'INTERNAL', 'SECRET'].includes(l));
      if (invalid.length > 0) {
        throw new BizException(ErrorCode.BAD_REQUEST, `非法密级：${invalid.join(',')}`);
      }
    }
    if (query.retention) {
      const invalid = query.retention.filter((r) => !['PERM', 'Y30', 'Y10'].includes(r));
      if (invalid.length > 0) {
        throw new BizException(ErrorCode.BAD_REQUEST, `非法保管期限：${invalid.join(',')}`);
      }
    }
    if (query.status) {
      const invalid = query.status.filter((s) => !ITEM_STATUS_VALUES.includes(s));
      if (invalid.length > 0) {
        throw new BizException(ErrorCode.BAD_REQUEST, `非法状态：${invalid.join(',')}`);
      }
    }
  }
}
