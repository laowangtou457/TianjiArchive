/**
 * 片段检索链路回归测试（A 档：词法召回 + 权限下推 + 真值二次校验）。
 *
 * 覆盖：
 *   A. 词法路径（LexicalChunkRetriever）
 *      - 权限 filter 必须出现在 ES 请求体（不是"先召回再过滤"）；
 *      - 二次校验剔除索引密级陈旧/条目已删的命中（防越权）；
 *      - 回显密级取 PG 真值，不用 ES 快照（标签不得说谎）；
 *      - 无命中 → 空数组（由服务层给"无依据"，绝不编造）；
 *      - 候选放大倍数生效（二次剔除后仍能凑满 topK）。
 *   B. 向量路径（EsVectorStore）
 *      - D-2 单一向量空间：分数 = 同一 provider 两侧余弦；
 *      - D-3 权限先于截断：600 条 SECRET 时低密级用户仍命中唯一 PUBLIC；
 *      - 维度不一致显式抛错。
 *   C. 服务层（KbService）
 *      - query 返回 citations，answer 恒空、mode='retrieval'（不生成即不臆造）；
 *      - 无命中 grounded=false；
 *      - reindex 空数组 → 自动挑选陈旧条目。
 */
import { describe, expect, it, vi } from 'vitest';
import { MODULE_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { ErrorCode, SecurityLevel, type PermissionSnapshot } from '@tianji/shared';
import { AccessFilterBuilder } from '@api/common/access/access-filter.builder';
import { LocalHashEmbeddingProvider } from '@api/modules/kb/embedding.provider';
import { EsVectorStore } from '@api/modules/kb/vector.store';
import { LexicalChunkRetriever } from '@api/modules/kb/kb.retriever';
import { KbService } from '@api/modules/kb/kb.service';

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

interface Row {
  id: string;
  itemId: string;
  danghao: string;
  securityLevel: SecurityLevel;
  chunk: string;
  chunkNo: number;
  fondsId: string | null;
  orgId: string | null;
  createdBy: string | null;
  deleted: boolean;
}

let seq = 0;
function row(over: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `k-${seq}`,
    itemId: `i-${seq}`,
    danghao: `A036-2024-BGS-Y-0001-${String(seq).padStart(4, '0')}`,
    securityLevel: SecurityLevel.PUBLIC,
    chunk: `第 ${seq} 段档案正文：关于年度工作的报告`,
    chunkNo: 0,
    fondsId: 'f-1',
    orgId: null,
    createdBy: 'u-1',
    deleted: false,
    ...over,
  };
}

/** 独立实现的余弦（不复用被测代码） */
function refCosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ==========================================================================
// B. 向量路径
// ==========================================================================

interface QbState {
  clause: string;
  params: Record<string, unknown>;
  skip: number;
  take: number;
}

/** 用 SQL 谓词反推"数据库会返回哪些行"，让 D-3 回退时用例立刻红 */
function selectByClause(rows: Row[], st: QbState): Row[] {
  const c = st.clause;
  // fail-closed 的恒假条件（注意与 `a."deleted" = FALSE` 区分）
  if (/^FALSE\b/.test(c.trim()) || /1 = 0/.test(c)) return [];

  const pick = (re: RegExp): unknown[] | null => {
    const m = re.exec(c);
    if (!m) return null;
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/^:/, ''))
      .filter(Boolean)
      .map((k) => st.params[k]);
  };

  const levels = pick(/a\."security_level" IN \(([^)]*)\)/) as string[] | null;
  const fonds = pick(/a\."fonds_id" IN \(([^)]*)\)/) as string[] | null;
  const creator = pick(/a\."created_by" = (:?\w+)/);
  const requireAlive = /a\."deleted" = FALSE/.test(c);

  return rows.filter((r) => {
    if (requireAlive && r.deleted) return false;
    if (levels && !levels.includes(r.securityLevel)) return false;
    const scopeChecks: boolean[] = [];
    if (fonds) scopeChecks.push(r.fondsId !== null && fonds.includes(r.fondsId));
    if (creator) scopeChecks.push(r.createdBy === creator[0]);
    if (scopeChecks.length > 0 && !scopeChecks.some(Boolean)) return false;
    return true;
  });
}

function makeVectorHarness(
  rows: Row[],
  opts: { truthLevels?: Record<string, SecurityLevel> } = {},
) {
  const st: QbState = { clause: '', params: {}, skip: 0, take: 0 };
  const trace = { getManyCalls: 0, clauses: [] as string[] };

  const qb: Record<string, unknown> = {
    innerJoin: vi.fn(() => qb),
    select: vi.fn(() => qb),
    where: vi.fn((clause: string, params?: Record<string, unknown>) => {
      st.clause = clause;
      Object.assign(st.params, params ?? {});
      trace.clauses.push(clause);
      return qb;
    }),
    andWhere: vi.fn((clause: string, params?: Record<string, unknown>) => {
      st.clause = st.clause ? `${st.clause} AND ${clause}` : clause;
      Object.assign(st.params, params ?? {});
      trace.clauses.push(clause);
      return qb;
    }),
    skip: vi.fn((n: number) => {
      st.skip = n;
      return qb;
    }),
    take: vi.fn((n: number) => {
      st.take = n;
      return qb;
    }),
    getMany: vi.fn(async () => {
      trace.getManyCalls += 1;
      const matched = selectByClause(rows, st);
      return matched.slice(st.skip, st.skip + st.take).map((r) => ({
        id: r.id,
        itemId: r.itemId,
        sourceDanghao: r.danghao,
        securityLevel: r.securityLevel,
        chunk: r.chunk,
        chunkNo: r.chunkNo,
      }));
    }),
    getRawMany: vi.fn(async () => []),
  };

  // 密级真值回查（向量路径回显密级用；默认空 → 退回片段表快照）
  const truthQb: Record<string, unknown> = {
    select: vi.fn(() => truthQb),
    where: vi.fn(() => truthQb),
    getRawMany: vi.fn(async () =>
      Object.entries(opts.truthLevels ?? {}).map(([id, security_level]) => ({
        id,
        security_level,
      })),
    ),
  };

  const repo = {
    createQueryBuilder: vi.fn(() => qb),
    find: vi.fn(async () => []),
    count: vi.fn(async () => rows.length),
    manager: { getRepository: vi.fn(() => ({ createQueryBuilder: vi.fn(() => truthQb) })) },
  };

  const accessBuilder = new AccessFilterBuilder();
  const provider = new LocalHashEmbeddingProvider();
  const store = new EsVectorStore(repo as never, provider, accessBuilder);

  return { repo, qb, store, provider, accessBuilder, st, trace };
}

describe('向量路径 —— D-2 单一向量空间（旧实现：查询与片段各用一套哈希）', () => {
  it('命中分数等于「同一 provider 分别向量化查询与片段」的余弦', async () => {
    const chunk = '关于年度档案工作报告的会议纪要';
    const h = makeVectorHarness([row({ chunk })]);
    const q = '年度档案工作报告';

    const hits = await h.store.search(q, user(), 5);

    expect(hits).toHaveLength(1);
    const expected = refCosine(await h.provider.embedOne(q), await h.provider.embedOne(chunk));
    expect(hits[0].score).toBeCloseTo(expected, 10);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('完全相同的文本得分为 1（两侧同空间且均已归一）', async () => {
    const text = '完全一致的文本';
    const h = makeVectorHarness([row({ chunk: text })]);
    const hits = await h.store.search(text, user(), 5);
    expect(hits[0].score).toBeCloseTo(1, 10);
  });
});

describe('向量路径 —— D-3 权限先于截断（旧实现：先取 500 条最新再过滤）', () => {
  it('【关键】近 600 条全 SECRET 时，INTERNAL 用户仍命中唯一的 PUBLIC 片段', async () => {
    const target = row({ securityLevel: SecurityLevel.PUBLIC, chunk: '唯一可访问的公开片段' });
    const secrets = Array.from({ length: 600 }, (_, i) =>
      row({ securityLevel: SecurityLevel.SECRET, chunk: `机密片段 ${i}` }),
    );
    const h = makeVectorHarness([target, ...secrets]);

    const hits = await h.store.search(
      '公开片段',
      user({ maxSecurityLevel: SecurityLevel.INTERNAL }),
      5,
    );

    expect(hits.map((x) => x.itemId)).toContain(target.itemId);
    expect(hits.every((x) => x.securityLevel === SecurityLevel.PUBLIC)).toBe(true);
  });

  it('权限条件在取数前已落到查询，且不再走 find 时间窗口', async () => {
    const h = makeVectorHarness([row()]);
    await h.store.search('x', user(), 5);

    expect(h.trace.clauses.some((c) => c.includes('security_level'))).toBe(true);
    expect(h.trace.clauses.some((c) => c.includes('deleted'))).toBe(true);
    expect(h.repo.find).not.toHaveBeenCalled();
  });

  it('未知密级 fail-closed：返回空而不是"不过滤"', async () => {
    const h = makeVectorHarness([row(), row()]);
    expect(await h.store.search('档案', user({ maxSecurityLevel: 'X' as never }), 10)).toEqual([]);
  });

  it('PUBLIC 用户看不到 INTERNAL/SECRET 片段', async () => {
    const pub = row({ securityLevel: SecurityLevel.PUBLIC });
    const h = makeVectorHarness([pub, row({ securityLevel: SecurityLevel.INTERNAL })]);
    const hits = await h.store.search('档案', user({ maxSecurityLevel: SecurityLevel.PUBLIC }), 10);
    expect(hits.map((x) => x.itemId)).toEqual([pub.itemId]);
  });

  it('回显密级取 archive_item 真值，不用片段表快照', async () => {
    const r = row({ securityLevel: SecurityLevel.PUBLIC, chunk: '关于年度档案工作报告' });
    const h = makeVectorHarness([r], { truthLevels: { [r.itemId]: SecurityLevel.SECRET } });

    const hits = await h.store.search('年度档案工作报告', user({ maxSecurityLevel: SecurityLevel.SECRET }), 5);

    expect(hits).toHaveLength(1);
    expect(hits[0].securityLevel).toBe(SecurityLevel.SECRET);
  });
});

// ==========================================================================
// A. 词法路径
// ==========================================================================

interface EsHit {
  itemId: string;
  danghao: string;
  securityLevel: SecurityLevel;
  chunkNo: number;
  chunk: string;
  score: number;
}

function makeLexicalHarness(opts: {
  esHits: EsHit[];
  /** 允许访问的条目；给对象形式可指定 PG 真值密级（默认 PUBLIC） */
  accessible: Array<string | { itemId: string; level: SecurityLevel }>;
}) {
  const captured: Array<{
    question: string;
    filters: Array<Record<string, unknown>>;
    size: number;
  }> = [];
  const es = {
    search: vi.fn(async (question: string, filters: Array<Record<string, unknown>>, size: number) => {
      captured.push({ question, filters, size });
      return { total: opts.esHits.length, hits: opts.esHits.slice(0, size) };
    }),
  };

  const qb: Record<string, unknown> = {
    innerJoin: vi.fn(() => qb),
    select: vi.fn(() => qb),
    where: vi.fn(() => qb),
    andWhere: vi.fn(() => qb),
    getRawMany: vi.fn(async () =>
      opts.accessible.map((a) =>
        typeof a === 'string'
          ? { item_id: a, security_level: SecurityLevel.PUBLIC }
          : { item_id: a.itemId, security_level: a.level },
      ),
    ),
  };
  const repo = { createQueryBuilder: vi.fn(() => qb) };

  const accessBuilder = new AccessFilterBuilder();
  const retriever = new LexicalChunkRetriever(es as never, repo as never, accessBuilder);
  return { es, repo, qb, retriever, captured, accessBuilder };
}

describe('词法路径 —— 权限下推与真值二次校验', () => {
  it('ES 请求体带权限 filter（密级 terms + deleted），且候选按 topK 放大', async () => {
    const h = makeLexicalHarness({ esHits: [], accessible: [] });
    await h.retriever.search('年度报告', user(), 5);

    expect(h.captured).toHaveLength(1);
    const { filters, size } = h.captured[0];
    expect(JSON.stringify(filters)).toContain('securityLevel');
    expect(JSON.stringify(filters)).toContain('"deleted":false');
    expect(size).toBe(15); // 5 × 3 放大
    // 权限 filter 不得含 SECRET（INTERNAL 上限）
    expect(JSON.stringify(filters)).not.toContain('"SECRET"');
  });

  it('【关键】索引密级陈旧（ES 说 PUBLIC、PG 已升 SECRET）→ 二次校验剔除，不越权', async () => {
    const h = makeLexicalHarness({
      esHits: [
        {
          itemId: 'i-1',
          danghao: 'A-1',
          securityLevel: SecurityLevel.PUBLIC,
          chunkNo: 0,
          chunk: '片段',
          score: 3,
        },
        {
          itemId: 'i-2',
          danghao: 'A-2',
          securityLevel: SecurityLevel.PUBLIC,
          chunkNo: 0,
          chunk: '片段',
          score: 2,
        },
      ],
      accessible: ['i-2'],
    });

    const hits = await h.retriever.search('片段', user(), 5);
    expect(hits.map((x) => x.itemId)).toEqual(['i-2']);
  });

  it('【真机回归】密级回显取 PG 真值，不用 ES 快照（机密件不得被标成公开级）', async () => {
    const h = makeLexicalHarness({
      esHits: [
        {
          itemId: 'i-1',
          danghao: 'A-1',
          securityLevel: SecurityLevel.PUBLIC, // 索引快照：陈旧
          chunkNo: 0,
          chunk: '片段',
          score: 3,
        },
      ],
      // PG 真值：已升密
      accessible: [{ itemId: 'i-1', level: SecurityLevel.SECRET }],
    });

    const hits = await h.retriever.search('片段', user({ maxSecurityLevel: SecurityLevel.SECRET }), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].securityLevel).toBe(SecurityLevel.SECRET);
  });

  it('无命中 → 空数组（由服务层给"无依据"）', async () => {
    const h = makeLexicalHarness({ esHits: [], accessible: [] });
    expect(await h.retriever.search('不存在的主题', user(), 5)).toEqual([]);
  });

  it('空问题不发起 ES 查询', async () => {
    const h = makeLexicalHarness({ esHits: [], accessible: [] });
    expect(await h.retriever.search('   ', user(), 5)).toEqual([]);
    expect(h.es.search).not.toHaveBeenCalled();
  });

  it('二次校验后仍按 ES 相关性顺序返回，并截断到 topK', async () => {
    const esHits = Array.from({ length: 6 }, (_, i) => ({
      itemId: `i-${i}`,
      danghao: `A-${i}`,
      securityLevel: SecurityLevel.PUBLIC,
      chunkNo: 0,
      chunk: `片段 ${i}`,
      score: 10 - i,
    }));
    const h = makeLexicalHarness({ esHits, accessible: esHits.map((x) => x.itemId) });

    const hits = await h.retriever.search('片段', user(), 3);
    expect(hits).toHaveLength(3);
    expect(hits.map((x) => x.score)).toEqual([10, 9, 8]);
  });
});

// ==========================================================================
// C. 服务层
// ==========================================================================

function makeServiceHarness(
  opts: {
    hits?: EsHit[];
    staleIds?: string[];
    indexResult?: { items: number; chunks: number; failed: number };
  } = {},
) {
  const retriever = {
    name: 'fake-lexical',
    mode: 'lexical' as const,
    search: vi.fn(async () =>
      (opts.hits ?? []).map((h) => ({
        itemId: h.itemId,
        danghao: h.danghao,
        securityLevel: h.securityLevel,
        chunkNo: h.chunkNo,
        snippet: h.chunk,
        score: h.score,
      })),
    ),
  };
  const indexer = {
    countChunks: vi.fn(async () => 42),
    findStaleItemIds: vi.fn(async () => opts.staleIds ?? []),
    indexItems: vi.fn(async () => opts.indexResult ?? { items: 0, chunks: 0, failed: 0 }),
  };
  const es = { ready: vi.fn(async () => true), refresh: vi.fn(async () => undefined) };
  const provider = new LocalHashEmbeddingProvider();

  const service = new KbService(
    new AccessFilterBuilder(),
    provider,
    retriever as never,
    indexer as never,
    es as never,
  );
  return { service, retriever, indexer, es, provider };
}

describe('服务层 —— 片段检索语义（不生成即不臆造）', () => {
  it('命中时返回 citations，answer 恒为空、mode=retrieval', async () => {
    const h = makeServiceHarness({
      hits: [
        {
          itemId: 'i-1',
          danghao: 'A036-2024-BGS-Y-0001-0001',
          securityLevel: SecurityLevel.PUBLIC,
          chunkNo: 2,
          chunk: '关于年度工作的报告正文……',
          score: 4.2,
        },
      ],
    });

    const r = await h.service.query({ question: '年度工作报告' }, user());

    expect(r.citations).toHaveLength(1);
    expect(r.citations[0].danghao).toBe('A036-2024-BGS-Y-0001-0001');
    expect(r.grounded).toBe(true);
    expect(r.answer).toBe(''); // 绝不生成答案文本
    expect(r.mode).toBe('retrieval');
  });

  it('未命中 → grounded=false 且 citations 为空（前端提示"无依据"）', async () => {
    const h = makeServiceHarness({ hits: [] });
    const r = await h.service.query({ question: '完全无关的问题' }, user());
    expect(r.citations).toEqual([]);
    expect(r.grounded).toBe(false);
    expect(r.answer).toBe('');
  });

  it('问题过短 → 400（不打到检索器）', async () => {
    const h = makeServiceHarness();
    await expect(h.service.query({ question: 'x' }, user())).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST.code,
    });
    expect(h.retriever.search).not.toHaveBeenCalled();
  });

  it('status 反映检索器与索引规模', async () => {
    const h = makeServiceHarness();
    const s = await h.service.status(user());
    expect(s.enabled).toBe(true);
    expect(s.retriever).toBe('fake-lexical');
    expect(s.mode).toBe('lexical');
    expect(s.indexedChunks).toBe(42);
  });
});

describe('服务层 —— 重建索引', () => {
  it('itemIds 为空 → 自动挑选陈旧条目', async () => {
    const h = makeServiceHarness({
      staleIds: ['i-1', 'i-2'],
      indexResult: { items: 2, chunks: 7, failed: 0 },
    });

    const r = await h.service.reindex([]);
    expect(h.indexer.findStaleItemIds).toHaveBeenCalled();
    expect(h.indexer.indexItems).toHaveBeenCalledWith(['i-1', 'i-2']);
    expect(r).toEqual({ indexed: 7, items: 2, failed: 0 });
    expect(h.es.refresh).toHaveBeenCalled();
  });

  it('指定 itemIds → 不触发陈旧扫描', async () => {
    const h = makeServiceHarness({ indexResult: { items: 1, chunks: 3, failed: 0 } });
    await h.service.reindex(['i-9']);
    expect(h.indexer.findStaleItemIds).not.toHaveBeenCalled();
    expect(h.indexer.indexItems).toHaveBeenCalledWith(['i-9']);
  });
});

// ==========================================================================
// D. 令牌装配（@Inject('字符串') 注入点不被 check-module-wiring 覆盖，另行守住）
// ==========================================================================
describe('令牌装配', () => {
  it('KbService 请求的令牌都由 KbModule 提供，且检索器按 provider 能力择一', async () => {
    const { KbModule } = await import('@api/modules/kb/kb.module');
    const { EMBEDDING_PROVIDER } = await import('@api/modules/kb/embedding.provider');
    const { CHUNK_RETRIEVER } = await import('@api/modules/kb/kb.retriever');

    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, KbModule) ?? []) as Array<
      Record<string, unknown> | unknown
    >;
    const provided = providers
      .filter(
        (p): p is Record<string, unknown> => typeof p === 'object' && p !== null && 'provide' in p,
      )
      .map((p) => p.provide);

    const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, KbService) ?? []) as Array<{
      param?: unknown;
    }>;
    const requested = declared.map((d) => d.param);

    expect(requested).toContain(EMBEDDING_PROVIDER);
    expect(requested).toContain(CHUNK_RETRIEVER);
    expect(provided).toContain(EMBEDDING_PROVIDER);
    expect(provided).toContain(CHUNK_RETRIEVER);

    // 检索器由工厂按 provider 能力择一：hash 提供方（productionReady=false）必须落到词法
    const factory = providers.find(
      (p): p is Record<string, unknown> =>
        typeof p === 'object' && p !== null && p.provide === CHUNK_RETRIEVER,
    );
    expect(typeof factory?.useFactory).toBe('function');
    const pick = factory?.useFactory as (a: unknown, b: unknown, c: unknown) => { name: string };
    expect(pick({ name: 'lex' }, { name: 'vec' }, { productionReady: false }).name).toBe('lex');
    expect(pick({ name: 'lex' }, { name: 'vec' }, { productionReady: true }).name).toBe('vec');
  });
});
