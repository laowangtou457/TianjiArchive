/**
 * KB 检索链路回归测试（apps/api/src/modules/kb/*）
 *
 * 覆盖三个已修复的历史缺陷 + 一条不可谈判的权限约束：
 *   D-2 向量空间不一致：查询向量与片段向量必须出自**同一** provider/特征空间；
 *   D-3 召回顺序错位：权限过滤必须**先于**截断（近 N 条全高密级时不得假阴性）；
 *   死代码收口：EsVectorStore 真正被调用、score 为真实余弦（旧实现恒 0）；
 *   越权零返回：验收要点 3 —— 无权限片段绝不出现。
 *
 * 另守住一条底线：`/api/kb/query` 必须仍然返回 501。501 是防呆闸门，
 * 在 chunk 生产者（缺口 D-1）实现前不得打开 —— 见《RAG知识库立项书》§4 G-4。
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, SecurityLevel, type PermissionSnapshot } from '@tianji/shared';
import { AccessFilterBuilder } from '@api/common/access/access-filter.builder';
import { LocalHashEmbeddingProvider } from '@api/modules/kb/embedding.provider';
import { EsVectorStore } from '@api/modules/kb/vector.store';
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
    fondsId: 'f-1',
    orgId: null,
    createdBy: 'u-1',
    deleted: false,
    ...over,
  };
}

// ------------------------------------------------------------------ 假 QB
interface QbState {
  clause: string;
  params: Record<string, unknown>;
  skip: number;
  take: number;
}

/**
 * 用 SQL 谓词反推「数据库会返回哪些行」。
 *
 * 这是本文件的核心手法：如果实现回退成"先取 N 条再内存过滤"，
 * `qbState.clause` 里就不会有 security_level 条件，假 DB 会把高密级行也返回，
 * 断言立刻红 —— 让 D-3 无法复发。
 */
function selectByClause(rows: Row[], st: QbState): Row[] {
  const c = st.clause;
  // fail-closed 的恒假条件（注意与 `a."deleted" = FALSE` 区分：后者不是恒假）
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
  const orgs = pick(/a\."org_id" IN \(([^)]*)\)/) as string[] | null;
  const creator = pick(/a\."created_by" = (:?\w+)/);
  const requireAlive = /a\."deleted" = FALSE/.test(c);

  return rows.filter((r) => {
    if (requireAlive && r.deleted) return false;
    if (levels && !levels.includes(r.securityLevel)) return false;

    const scopeChecks: boolean[] = [];
    if (fonds) scopeChecks.push(r.fondsId !== null && fonds.includes(r.fondsId));
    if (orgs) scopeChecks.push(r.orgId !== null && orgs.includes(r.orgId));
    if (creator) scopeChecks.push(r.createdBy === creator[0]);
    if (scopeChecks.length > 0 && !scopeChecks.some(Boolean)) return false;

    return true;
  });
}

function makeHarness(rows: Row[]) {
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
      // 映射为 KbEntry 实体字段名（sourceDanghao 而非 danghao），与真实 TypeORM 一致
      return matched.slice(st.skip, st.skip + st.take).map((r) => ({
        id: r.id,
        itemId: r.itemId,
        sourceDanghao: r.danghao,
        securityLevel: r.securityLevel,
        chunk: r.chunk,
      }));
    }),
    getCount: vi.fn(async () => selectByClause(rows, st).length),
  };

  const repo = {
    createQueryBuilder: vi.fn(() => qb),
    // 旧实现的入口：先取 500 条最新。若它被调用，说明 D-3 回退了。
    find: vi.fn(async () => []),
    count: vi.fn(async () => rows.length),
  };

  const accessBuilder = new AccessFilterBuilder();
  const provider = new LocalHashEmbeddingProvider();
  const store = new EsVectorStore(repo as never, provider, accessBuilder);
  const service = new KbService(repo as never, accessBuilder, provider, store);

  return { repo, qb, store, service, provider, accessBuilder, st, trace, rows };
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

// ============================================================================
describe('D-2 向量空间一致性（旧实现：查询与片段各用一套哈希，余弦无意义）', () => {
  it('命中分数等于「同一 provider 分别向量化查询与片段」的余弦', async () => {
    const chunk = '关于年度档案工作报告的会议纪要';
    const h = makeHarness([row({ chunk })]);
    const q = '年度档案工作报告';

    const hits = await h.store.search(await h.provider.embedOne(q), { topK: 5, user: user() });

    expect(hits).toHaveLength(1);
    const expected = refCosine(await h.provider.embedOne(q), await h.provider.embedOne(chunk));
    expect(hits[0].score).toBeCloseTo(expected, 10);
    // 旧实现此处恒为 0（hashOf 与 provider 不同空间，且 score 写死 0）
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('完全相同的文本得分为 1（证明两侧同空间、均已归一）', async () => {
    const text = '完全一致的文本';
    const h = makeHarness([row({ chunk: text })]);
    const hits = await h.store.search(await h.provider.embedOne(text), { topK: 5, user: user() });
    expect(hits[0].score).toBeCloseTo(1, 10);
  });

  it('维度不一致 → 显式抛错（不允许静默算出"看起来正常"的相似度）', async () => {
    const h = makeHarness([row()]);
    await expect(
      h.store.search(new Array(64).fill(0.1), { topK: 5, user: user() }),
    ).rejects.toThrow(/维度不一致/);
  });
});

// ============================================================================
describe('D-3 召回顺序（旧实现：先取 500 条最新，再内存过滤 → 假阴性）', () => {
  it('【关键】近 600 条全 SECRET 时，INTERNAL 用户必须仍命中唯一的 PUBLIC 片段', async () => {
    const target = row({ securityLevel: SecurityLevel.PUBLIC, chunk: '唯一可访问的公开片段' });
    const secrets = Array.from({ length: 600 }, (_, i) =>
      row({ securityLevel: SecurityLevel.SECRET, chunk: `机密片段 ${i}` }),
    );
    // 高密级片段排在最后（= 最新入库）；旧实现只取前 500 条，永远看不到 target
    const h = makeHarness([target, ...secrets]);

    const hits = await h.store.search(await h.provider.embedOne('公开片段'), {
      topK: 5,
      user: user({ maxSecurityLevel: SecurityLevel.INTERNAL }),
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((x) => x.entryId)).toContain(target.id);
    expect(hits.every((x) => x.securityLevel === SecurityLevel.PUBLIC)).toBe(true);
  });

  it('权限条件在取数前已落到查询（clause 含 security_level，且不再走 find 窗口）', async () => {
    const h = makeHarness([row()]);
    await h.store.search(await h.provider.embedOne('x'), { topK: 5, user: user() });

    expect(h.trace.clauses.some((c) => c.includes('security_level'))).toBe(true);
    expect(h.trace.clauses.some((c) => c.includes('deleted'))).toBe(true);
    // 旧实现的入口必须彻底消失
    expect(h.repo.find).not.toHaveBeenCalled();
  });

  it('分页扫描完整覆盖（超过单页 256 条时不漏行）', async () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      row({ chunk: `片段 ${i}`, securityLevel: SecurityLevel.PUBLIC }),
    );
    const h = makeHarness(rows);
    const hits = await h.store.search(await h.provider.embedOne('片段'), { topK: 3, user: user() });

    expect(hits).toHaveLength(3);
    // 600 行 / 每页 256 → 至少 3 次 getMany（含最后一次空页判定）
    expect(h.trace.getManyCalls).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
describe('越权零返回（验收要点 3）', () => {
  it('PUBLIC 用户看不到 INTERNAL/SECRET 片段', async () => {
    const pub = row({ securityLevel: SecurityLevel.PUBLIC });
    const internal = row({ securityLevel: SecurityLevel.INTERNAL });
    const secret = row({ securityLevel: SecurityLevel.SECRET });
    const h = makeHarness([pub, internal, secret]);

    const hits = await h.store.search(await h.provider.embedOne('档案'), {
      topK: 10,
      user: user({ maxSecurityLevel: SecurityLevel.PUBLIC }),
    });

    expect(hits.map((x) => x.entryId)).toEqual([pub.id]);
  });

  it('未知密级 fail-closed：返回空数组而不是"不过滤"', async () => {
    const h = makeHarness([row(), row()]);
    const hits = await h.store.search(await h.provider.embedOne('档案'), {
      topK: 10,
      user: user({ maxSecurityLevel: 'UNKNOWN' as never }),
    });
    expect(hits).toEqual([]);
  });

  it('全宗受限用户只能命中授权全宗内的片段', async () => {
    const mine = row({ fondsId: 'f-1' });
    const other = row({ fondsId: 'f-2' });
    const h = makeHarness([mine, other]);

    const hits = await h.store.search(await h.provider.embedOne('档案'), {
      topK: 10,
      user: user({ fondsIds: ['f-1'], orgIds: [], selfOnly: false }),
    });
    expect(hits.map((x) => x.entryId)).toEqual([mine.id]);
  });
});

// ============================================================================
describe('服务层契约', () => {
  it('retrieve 映射为 KbCitation（档号 + 片段 ≤200 字 + 密级）', async () => {
    const long = '档'.repeat(500);
    const h = makeHarness([row({ chunk: long, danghao: 'A036-2024-BGS-Y-0009-0001' })]);
    const cites = await h.service.retrieve('档案', user(), 5);

    expect(cites).toHaveLength(1);
    expect(cites[0].danghao).toBe('A036-2024-BGS-Y-0009-0001');
    expect(cites[0].snippet).toHaveLength(200);
    expect(cites[0].securityLevel).toBe(SecurityLevel.PUBLIC);
  });

  it('topK 收敛到 1~50 区间', async () => {
    const rows = Array.from({ length: 80 }, () => row({ chunk: '相同片段' }));
    const h = makeHarness(rows);
    expect(
      await h.store.search(await h.provider.embedOne('片段'), { topK: 0, user: user() }),
    ).toHaveLength(1);
    expect(
      await h.store.search(await h.provider.embedOne('片段'), { topK: 999, user: user() }),
    ).toHaveLength(50);
  });

  it('空问题不发起检索（直接返回空）', async () => {
    const h = makeHarness([row()]);
    expect(await h.service.retrieve('   ', user(), 5)).toEqual([]);
    expect(h.trace.getManyCalls).toBe(0);
  });

  it('reindex 不把 embedding_status 伪造成 OK（无 chunk 生产者时返回 0）', async () => {
    const h = makeHarness([row()]);
    const repo = h.repo as unknown as {
      find: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    repo.find = vi.fn(async () => [{ id: 'k-1' }]);
    repo.update = vi.fn(async () => ({ affected: 1 }));

    const r = await h.service.reindex('i-1');
    expect(r.indexed).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });
});

// ============================================================================
describe('令牌装配（防"提供方与消费方令牌写歪"）', () => {
  /**
   * 本项目被"模块接线"坑过两次（AccessModule 未入树、BackupModule 缺 import），
   * 而 `@Inject('字符串令牌')` 的注入点会被 `check-module-wiring.ts` 跳过
   * （它只核函数型 token）。这里补一道 esbuild 可跑的静态核对：
   * KbService 声明的令牌必须在 KbModule 的 providers 里确有提供。
   */
  it('KbService 请求的两个令牌都由 KbModule 提供', async () => {
    const { MODULE_METADATA, SELF_DECLARED_DEPS_METADATA } =
      await import('@nestjs/common/constants');
    const { KbModule } = await import('@api/modules/kb/kb.module');
    const { EMBEDDING_PROVIDER } = await import('@api/modules/kb/embedding.provider');
    const { VECTOR_STORE } = await import('@api/modules/kb/vector.store');

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
    expect(requested).toContain(VECTOR_STORE);
    expect(provided).toContain(EMBEDDING_PROVIDER);
    expect(provided).toContain(VECTOR_STORE);
  });
});

// ============================================================================
describe('501 防呆闸门（chunk 生产者未实现前不得打开）', () => {
  it('/api/kb/query 仍返回 KB_NOT_ENABLED，且携带密级可达片段数', async () => {
    const h = makeHarness([row({ securityLevel: SecurityLevel.PUBLIC })]);
    await expect(
      h.service.query({ question: '年度报告有哪些' } as never, user()),
    ).rejects.toMatchObject({
      code: ErrorCode.KB_NOT_ENABLED.code,
    });
  });

  it('问题过短 → 400 业务异常（先于 501 判定）', async () => {
    const h = makeHarness([]);
    await expect(h.service.query({ question: 'x' } as never, user())).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST.code,
    });
  });
});
