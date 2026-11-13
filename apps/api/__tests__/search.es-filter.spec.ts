/**
 * 全文检索 ES filter 落地测试（apps/api/src/modules/search/search.service.ts）
 *
 * 验收要点 3：「无权限条目不出现」。
 * 本用例直接捕获 SearchService 发给 ES 的请求体，逐项断言：
 *   ① 权限 filter（securityLevel / fondsId / deleted）必须在 query.bool.filter 中；
 *   ② 用户勾选的密级只能是自身可访问范围的子集（防止越权扩大结果集）；
 *   ③ ES 不可用时降级 PG 分支同样带权限过滤；
 *   ④ 排序 / 分页 / 高亮参数正确。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchService } from '@api/modules/search/search.service';
import { AccessFilterBuilder } from '@api/common/access/access-filter.builder';
import { SecurityLevel, type PermissionSnapshot } from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
function user(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
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

interface Captured {
  body: Record<string, unknown>;
}

function makeHarness(opts: { esFails?: boolean } = {}) {
  const captured: Captured[] = [];

  const esClient = {
    search: vi.fn(async (req: { body: Record<string, unknown> }) => {
      captured.push({ body: req.body });
      if (opts.esFails) throw new Error('connection refused');
      return {
        took: 3,
        hits: {
          total: { value: 2 },
          hits: [
            {
              _id: 'i-1',
              _score: 1.5,
              _source: {
                id: 'i-1',
                danghao: 'A036-2024-BGS-Y-0001-0001',
                title: '关于年度工作的报告',
                responsible: '办公室',
                year: 2024,
                retention: 'PERM',
                securityLevel: 'INTERNAL',
                fondsId: 'f-1',
                status: 'ARCHIVED',
                openFlag: 'OPEN',
                fileCount: 1,
                hasPreview: true,
              },
              highlight: { title: ['关于<em class="hl">年度</em>工作的报告'] },
            },
            {
              _id: 'i-2',
              _score: 1.1,
              _source: {
                id: 'i-2',
                danghao: 'A036-2024-BGS-Y-0001-0002',
                title: '年度计划',
                year: 2024,
                retention: 'PERM',
                securityLevel: 'PUBLIC',
                fondsId: 'f-1',
                status: 'DRAFT',
                openFlag: 'CONTROLLED',
                fileCount: 0,
                hasPreview: false,
              },
            },
          ],
        },
        aggregations: {
          fonds: { buckets: [{ key: 'f-1', doc_count: 2 }] },
          year: { buckets: [{ key: '2024', doc_count: 2 }] },
          retention: { buckets: [{ key: 'PERM', doc_count: 2 }] },
          level: {
            buckets: [
              { key: 'PUBLIC', doc_count: 1 },
              { key: 'INTERNAL', doc_count: 1 },
            ],
          },
          category: { buckets: [] },
        },
      };
    }),
  };

  const itemQb = () => {
    const qb: Record<string, unknown> = {};
    const chain = () => qb;
    for (const m of ['andWhere', 'orderBy', 'addOrderBy', 'skip', 'take', 'where']) {
      qb[m] = vi.fn(chain);
    }
    qb.getManyAndCount = vi.fn(async () => [[], 0]);
    return qb;
  };

  const itemRepo = {
    createQueryBuilder: vi.fn(itemQb),
    find: vi.fn(async () => []),
  };
  const fondsRepo = { find: vi.fn(async () => [{ id: 'f-1', fondsNo: 'A036', name: '某单位' }]) };
  const fileRepo = { count: vi.fn(async () => 0), query: vi.fn(async () => []) };
  const historyRepo = {
    create: vi.fn((v: Record<string, unknown>) => v),
    save: vi.fn(async (v: Record<string, unknown>) => v),
    find: vi.fn(async () => []),
  };

  const accessBuilder = new AccessFilterBuilder();
  const es = { index: 'archive_items', client: esClient };

  // 同义词与缓存对「权限过滤」这条断言无影响，给最小可用桩：
  // expand 恒返回空（不引入额外 must 子句），redis 恒 miss（不走缓存短路）。
  const synonyms = { expand: vi.fn(async () => [] as string[]) };
  const redis = {
    getJson: vi.fn(async () => null),
    setJson: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    incr: vi.fn(async () => 1),
  };
  const esIndexer = {
    syncItem: vi.fn(async () => undefined),
    reindexAll: vi.fn(async () => ({ indexed: 0 })),
  };

  const service = new SearchService(
    itemRepo as never,
    fondsRepo as never,
    fileRepo as never,
    historyRepo as never,
    es as never,
    accessBuilder,
    esIndexer as never,
    synonyms as never,
    redis as never,
  );

  return { service, captured, esClient, itemRepo, historyRepo, accessBuilder };
}

/** 取出 ES 请求体里的 bool.filter 数组 */
function filtersOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const q = body.query as { bool?: { filter?: Array<Record<string, unknown>> } };
  return q?.bool?.filter ?? [];
}

/** 在 filters 中按字段找 terms 值 */
function levelTerms(filters: Array<Record<string, unknown>>): string[] | null {
  for (const f of filters) {
    const terms = f.terms as Record<string, unknown> | undefined;
    if (terms && 'securityLevel' in terms) return terms.securityLevel as string[];
  }
  return null;
}

// ============================================================================
describe('ES 检索 —— 权限 filter 必须落到请求体', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('【关键】请求体 filter 中包含密级 terms（INTERNAL 上限 → 不含 SECRET）', async () => {
    await h.service.fulltext({ q: '年度报告' }, user());
    expect(h.captured).toHaveLength(1);
    const filters = filtersOf(h.captured[0].body);
    const levels = levelTerms(filters);
    expect(levels).toBeTruthy();
    expect(levels).toContain('PUBLIC');
    expect(levels).toContain('INTERNAL');
    expect(levels).not.toContain('SECRET');
  });

  it('【关键】PUBLIC 上限用户的 filter 只含 PUBLIC', async () => {
    await h.service.fulltext({ q: 'x' }, user({ maxSecurityLevel: SecurityLevel.PUBLIC }));
    const levels = levelTerms(filtersOf(h.captured[0].body));
    expect(levels).toEqual(['PUBLIC']);
  });

  it('【关键】软删除过滤始终存在', async () => {
    await h.service.fulltext({ q: 'x' }, user());
    expect(filtersOf(h.captured[0].body)).toContainEqual({ term: { deleted: false } });
  });

  it('【关键】限定全宗时 filter 含 fondsId terms（权限范围与显式条件同时生效）', async () => {
    await h.service.fulltext({ q: 'x', fonds: ['f-1'] }, user({ fondsIds: ['f-1'] }));
    const filters = filtersOf(h.captured[0].body);
    const hasFonds = filters.some((f) => {
      const t = f.terms as Record<string, unknown> | undefined;
      return t && 'fondsId' in t;
    });
    expect(hasFonds).toBe(true);
  });

  it('【关键】用户勾选 SECRET 但自身只有 INTERNAL → SECRET 被静默剔除（不放大范围）', async () => {
    await h.service.fulltext(
      { q: 'x', level: [SecurityLevel.PUBLIC, SecurityLevel.SECRET] },
      user({ maxSecurityLevel: SecurityLevel.INTERNAL }),
    );
    const body = h.captured[0].body;
    const allLevelTerms = JSON.stringify(body.query);
    // 允许出现 INTERNAL/PUBLIC 的 terms，但不允许 SECRET 出现在 filter 中
    const filters = filtersOf(body);
    const explicit = filters.filter((f) => {
      const t = f.terms as Record<string, unknown> | undefined;
      return t && 'securityLevel' in t && Array.isArray(t.securityLevel) && (t.securityLevel as string[]).length === 1;
    });
    for (const f of explicit) {
      expect((f.terms as { securityLevel: string[] }).securityLevel).not.toContain('SECRET');
    }
    // 权限 filter 本身也不含 SECRET
    expect(levelTerms(filters)).not.toContain('SECRET');
    expect(allLevelTerms).not.toContain('"SECRET"');
  });

  it('用户勾选的密级全部越权 → 返回空结果且**不发起 ES 查询**', async () => {
    const r = await h.service.fulltext(
      { q: 'x', level: [SecurityLevel.SECRET] },
      user({ maxSecurityLevel: SecurityLevel.PUBLIC }),
    );
    expect(r.total).toBe(0);
    expect(r.list).toEqual([]);
    // 只可能有检索历史相关调用，不应有 ES search
    expect(h.esClient.search).not.toHaveBeenCalled();
  });

  it('分页参数正确映射（page=3,size=50 → from=100）', async () => {
    await h.service.fulltext({ q: 'x', page: 3, size: 50 }, user());
    expect(h.captured[0].body.from).toBe(100);
    expect(h.captured[0].body.size).toBe(50);
  });

  it('非法 size（如 33）回落为 20（分页白名单）', async () => {
    await h.service.fulltext({ q: 'x', size: 33 }, user());
    expect(h.captured[0].body.size).toBe(20);
  });

  it('高亮与分面聚合配置存在', async () => {
    await h.service.fulltext({ q: '年度' }, user());
    const body = h.captured[0].body;
    expect(body.highlight).toBeDefined();
    const aggs = body.aggs as Record<string, unknown>;
    expect(Object.keys(aggs)).toEqual(
      expect.arrayContaining(['fonds', 'year', 'retention', 'level', 'category']),
    );
  });

  it('检索结果映射为 DTO（含高亮片段与分面桶）', async () => {
    const r = await h.service.fulltext({ q: '年度' }, user());
    expect(r.total).toBe(2);
    expect(r.list[0].danghao).toBe('A036-2024-BGS-Y-0001-0001');
    expect(r.list[0].highlights[0].fragments[0]).toContain('<em class="hl">年度</em>');
    expect(r.facets.securityLevel.find((b) => b.key === 'PUBLIC')?.label).toBe('公开');
  });

  it('检索历史写入（用于工作台「最近检索」）', async () => {
    await h.service.fulltext({ q: '年度报告' }, user());
    expect(h.historyRepo.save).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
describe('ES 不可用 → 降级 PG 全文检索', () => {
  it('ES 抛错时自动走 PG 分支，且仍带权限过滤条件', async () => {
    const h = makeHarness({ esFails: true });
    const qb = { andWhere: vi.fn(), orderBy: vi.fn(), addOrderBy: vi.fn(), skip: vi.fn(), take: vi.fn(), where: vi.fn() };
    const chain: Record<string, unknown> = {};
    for (const m of ['andWhere', 'orderBy', 'addOrderBy', 'skip', 'take', 'where']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.getManyAndCount = vi.fn(async () => [[], 0]);
    h.itemRepo.createQueryBuilder.mockReturnValue(chain);

    const r = await h.service.fulltext({ q: '年度' }, user({ maxSecurityLevel: SecurityLevel.PUBLIC }));
    expect(r.total).toBe(0);
    // 降级分支必须调用过 andWhere（权限过滤 + 关键词），不能是裸查询
    const calls = (chain.andWhere as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const firstClause = String(calls[0][0]);
    expect(firstClause).toContain('security_level');
    expect(firstClause).toContain('deleted');
    void qb;
  });
});

// ============================================================================
describe('条件检索 —— 字段白名单与注入防护', () => {
  it('不支持的字段 → 1001（防注入/越权字段）', async () => {
    const h = makeHarness();
    await expect(
      h.service.conditional({ filters: [{ field: 'password_hash', operator: 'eq', value: 'x' }] } as never, user()),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('不支持的运算符 → 1001', async () => {
    const h = makeHarness();
    await expect(
      h.service.conditional({ filters: [{ field: 'title', operator: 'regex', value: 'x' }] } as never, user()),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('between 参数不足两个值 → 1001', async () => {
    const h = makeHarness();
    await expect(
      h.service.conditional({ filters: [{ field: 'year', operator: 'between', value: [2024] }] } as never, user()),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('合法字段 + 运算符正常执行（返回分页结果）', async () => {
    const h = makeHarness();
    const chain: Record<string, unknown> = {};
    for (const m of ['andWhere', 'orderBy', 'addOrderBy', 'skip', 'take', 'where']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.getManyAndCount = vi.fn(async () => [[], 0]);
    h.itemRepo.createQueryBuilder.mockReturnValue(chain);
    const r = await h.service.conditional(
      { filters: [{ field: 'year', operator: 'gte', value: 2020 }] } as never,
      user(),
    );
    expect(r.total).toBe(0);
    expect(r.page).toBe(1);
  });
});
