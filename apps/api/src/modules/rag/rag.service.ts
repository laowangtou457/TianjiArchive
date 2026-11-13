import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { chunkText } from '@tianji/shared';
import type {
  PermissionSnapshot,
  RagAskResult,
  RagChunkHit,
  RagCitation,
  RagReindexResult,
  RagRetrieveResult,
  RagStatusDto,
  SecurityLevel,
} from '@tianji/shared';
import type { AppConfig } from '../../config/configuration';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { LlmGateway, OllamaEmbeddingProvider } from './embedding.provider';

/**
 * RAG 检索/问答服务（P4）。
 *
 * ## 与通用 RAG 的本质差异：检索前就做权限过滤
 *
 * 常见做法是「先召回 TopK，再过滤无权内容」——这在档案场景是**事故**：
 * 无权内容的向量已进入候选集，一旦 TopK 被过滤空了，模型会「根据空上下文编答案」；
 * 更糟的是，越权文本可能已经写进日志或缓存。
 *
 * 因此本服务的向量 SQL **必然带 AccessFilterBuilder 生成的密级/全宗条件**，
 * 召回即有权。这是与通用 RAG 唯一不可妥协的差别（架构 §11）。
 *
 * ## 两条召回路径
 *
 *   PGVECTOR       embedding 列为 vector(768) → `ORDER BY embedding <=> $q LIMIT k`
 *   ARRAY_FALLBACK embedding 列为 float8[]   → 取有权限的候选后应用内余弦
 *   LEXICAL        嵌入服务不可用 → 直接用分块内容做词法匹配（保证「没模型也能用」）
 *
 * 三条路径返回同一 DTO，前端不需要知道后端走哪条，只用 `mode` 提示可信度。
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  private storeKind: 'PGVECTOR' | 'ARRAY_FALLBACK' | null = null;

  private readonly topK: number;
  private readonly minScore: number;
  private readonly maxChunksPerItem: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly accessFilter: AccessFilterBuilder,
    private readonly embedding: OllamaEmbeddingProvider,
    private readonly llm: LlmGateway,
    private readonly config: ConfigService,
  ) {
    const rag = config.get<AppConfig['rag']>('rag');
    this.topK = rag?.topK ?? 6;
    this.minScore = rag?.minScore ?? 0.2;
    this.maxChunksPerItem = rag?.maxChunksPerItem ?? 40;
  }

  // ==========================================================================
  // 状态
  // ==========================================================================

  public async status(): Promise<RagStatusDto> {
    const kind = await this.detectStore();
    const [embeddingAvailable, counts] = await Promise.all([
      this.embedding.health(),
      this.dataSource.query(
        `SELECT (SELECT COUNT(*)::text FROM item_chunk WHERE deleted = FALSE) AS chunks,
                (SELECT COUNT(DISTINCT item_id)::text FROM item_chunk WHERE deleted = FALSE) AS items,
                (SELECT MAX(created_at) FROM item_chunk) AS last_at`,
      ) as Promise<Array<{ chunks: string; items: string; last_at: Date | null }>>,
    ]);
    return {
      embeddingProvider: this.embedding.name,
      embeddingModel: this.embedding.model,
      embeddingDim: this.embedding.dim,
      embeddingAvailable,
      llmModel: this.config.get<AppConfig['rag']>('rag')?.llmModel ?? null,
      // 生成模型可用性由 WikiController/Ask 路径按需探测，这里给的是「已配置」
      llmAvailable: embeddingAvailable,
      vectorStore: kind,
      chunkCount: Number.parseInt(counts[0]?.chunks ?? '0', 10),
      itemCount: Number.parseInt(counts[0]?.items ?? '0', 10),
      lastIndexedAt: counts[0]?.last_at ? new Date(counts[0].last_at).toISOString() : null,
    };
  }

  /**
   * 探测 embedding 列的真实类型（只探一次，进程内缓存）。
   *
   * 为什么不用环境变量判断：现场可能「有 pgvector 镜像但没 CREATE EXTENSION」，
   * 配置说 vector、实际是数组，SQL 会直接报错。以库为准，永不撒谎。
   */
  public async detectStore(): Promise<'PGVECTOR' | 'ARRAY_FALLBACK'> {
    if (this.storeKind) return this.storeKind;
    const rows: Array<{ t: string }> = await this.dataSource
      .query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS t
           FROM pg_attribute a
          WHERE a.attrelid = 'item_chunk'::regclass AND a.attname = 'embedding'`,
      )
      .catch(() => []);
    this.storeKind = rows[0]?.t?.includes('vector') ? 'PGVECTOR' : 'ARRAY_FALLBACK';
    this.logger.log(`向量存储形态：${this.storeKind}（列类型 ${rows[0]?.t ?? '未知'}）`);
    return this.storeKind;
  }

  // ==========================================================================
  // 检索
  // ==========================================================================

  public async retrieve(
    query: string,
    user: PermissionSnapshot,
    topK?: number,
  ): Promise<RagRetrieveResult> {
    const started = Date.now();
    const q = (query ?? '').trim();
    const k = Math.min(50, Math.max(1, topK ?? this.topK));
    if (q.length === 0) {
      return { query: q, hits: [], mode: 'LEXICAL', tookMs: 0, note: '查询为空' };
    }

    const available = await this.embedding.health();
    if (available) {
      try {
        const [vec] = await this.embedding.embed([q]);
        const kind = await this.detectStore();
        // 混合召回：向量 + 2-gram 词法各取 k 条再融合。
        // 为什么不是纯向量：中文短查询（如「四性检测」）在通用英文嵌入模型下
        // 语义漂移明显，纯向量会把「字面高度相关」的片段排到后面；
        // 词法补上精确匹配，向量补上同义/改写，两者互补远好于二选一。
        const [vecHits, lexHits] = await Promise.all([
          this.vectorSearch(vec, user, k, kind),
          this.lexicalSearch(q, user, k),
        ]);
        const hits = this.mergeHits(vecHits, lexHits, k);
        return {
          query: q,
          hits,
          mode: 'VECTOR',
          tookMs: Date.now() - started,
          note:
            hits.length === 0
              ? '未检索到与问题相关且您有权访问的档案片段'
              : `混合召回（向量 ${vecHits.length} + 词法 ${lexHits.length}）`,
        };
      } catch (err) {
        this.logger.warn(`向量检索失败，降级词法：${(err as Error).message}`);
      }
    }

    const hits = await this.lexicalSearch(q, user, k);
    return {
      query: q,
      hits,
      mode: 'LEXICAL',
      tookMs: Date.now() - started,
      note: available
        ? '向量检索异常，已降级为全文词法召回'
        : `嵌入模型不可用（${this.embedding.model}），当前为全文词法召回；配置 EMBEDDING_BASE_URL 后可启用语义检索`,
    };
  }

  /** 向量召回（SQL 内完成权限过滤 + 相似度排序） */
  private async vectorSearch(
    vec: number[],
    user: PermissionSnapshot,
    k: number,
    kind: 'PGVECTOR' | 'ARRAY_FALLBACK',
  ): Promise<RagChunkHit[]> {
    const filter = this.accessFilter.buildSql(user, 'i', { startIndex: 3 });
    const literal = OllamaEmbeddingProvider.literal(vec);

    if (kind === 'PGVECTOR') {
      const rows: Array<Record<string, unknown>> = await this.dataSource.query(
        `SELECT c.id, c.item_id, c.chunk_no, c.content, c.security_level,
                i.danghao, i.title,
                1 - (c.embedding <=> $1::vector) AS score
           FROM item_chunk c
           JOIN archive_item i ON i.id = c.item_id
          WHERE c.deleted = FALSE AND c.embedding IS NOT NULL
            AND ${filter.clause}
          ORDER BY c.embedding <=> $1::vector
          LIMIT $2`,
        [literal, k, ...filter.params],
      );
      return rows
        .map((r) => this.toHit(r))
        .filter((h) => h.score >= this.minScore);
    }

    // 数组回退：先按权限取候选（有上限），再在应用内算余弦。
    // 上限 4000 条是有意为之：再大就应改用 pgvector，而不是在 Node 里硬算。
    const rows: Array<{ id: string; item_id: string; chunk_no: number; content: string; security_level: string; danghao: string; title: string; embedding: number[] | null }> =
      await this.dataSource.query(
        `SELECT c.id, c.item_id, c.chunk_no, c.content, c.security_level,
                i.danghao, i.title, c.embedding
           FROM item_chunk c
           JOIN archive_item i ON i.id = c.item_id
          WHERE c.deleted = FALSE AND c.embedding IS NOT NULL
            AND ${filter.clause}
          LIMIT 4000`,
        filter.params,
      );
    return rows
      .map((r) => ({
        chunkId: r.id,
        itemId: r.item_id,
        danghao: r.danghao,
        title: r.title,
        chunkNo: r.chunk_no,
        content: r.content,
        score: this.cosine(vec, r.embedding ?? []),
        securityLevel: r.security_level as SecurityLevel,
      }))
      .filter((h) => h.score >= this.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * 词法召回（嵌入不可用时的兜底）。
   *
   * 中文没有空格，PG 的 tsvector 'simple' 分词对中文近乎无效，因此这里按
   * 「查询串整体 + 2-gram 切片」做 ILIKE 命中计数排序。召回质量不如向量，
   * 但足以让「没装模型」的环境仍能演示问答链路（并明确标注 degraded）。
   */
  private async lexicalSearch(
    query: string,
    user: PermissionSnapshot,
    k: number,
  ): Promise<RagChunkHit[]> {
    const filter = this.accessFilter.buildSql(user, 'i', { startIndex: 2 });
    const grams = this.ngrams(query);
    // LIMIT 的占位符序号 = 2（grams 之后是 filter 参数）+ filter 参数个数
    const limitIdx = 2 + filter.params.length;
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT c.id, c.item_id, c.chunk_no, c.content, c.security_level, i.danghao, i.title,
              (SELECT COUNT(*) FROM unnest($1::text[]) g WHERE c.content ILIKE '%' || g || '%') AS hits
         FROM item_chunk c
         JOIN archive_item i ON i.id = c.item_id
        WHERE c.deleted = FALSE AND ${filter.clause}
          AND EXISTS (SELECT 1 FROM unnest($1::text[]) g WHERE c.content ILIKE '%' || g || '%')
        ORDER BY hits DESC, c.created_at DESC
        LIMIT $${limitIdx}`,
      [grams, ...filter.params, k],
    );
    return rows.map((r) => {
      const hitCount = Number.parseInt(String(r.hits ?? '0'), 10);
      return {
        ...this.toHit(r),
        // 归一化到 0-1，仅用于展示；不代表语义相似度
        score: Math.min(1, hitCount / Math.max(1, grams.length)),
      };
    });
  }

  /**
   * 融合向量与词法召回结果。
   *
   * 权重 0.65/0.35：向量主导（能处理同义改写），词法保底（避免中文短查询漂移）。
   * 同一 chunk 两路都命中时分数相加（说明「字面 + 语义」双相关，应排更前）。
   */
  private mergeHits(vecHits: RagChunkHit[], lexHits: RagChunkHit[], k: number): RagChunkHit[] {
    const map = new Map<string, RagChunkHit>();
    for (const h of vecHits) {
      map.set(h.chunkId, { ...h, score: h.score * 0.65 });
    }
    for (const h of lexHits) {
      const cur = map.get(h.chunkId);
      if (cur) cur.score = Math.min(1, cur.score + h.score * 0.35);
      else map.set(h.chunkId, { ...h, score: h.score * 0.35 });
    }
    return [...map.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  // ==========================================================================
  // 问答
  // ==========================================================================

  public async ask(
    question: string,
    user: PermissionSnapshot,
    topK?: number,
  ): Promise<RagAskResult> {
    const started = Date.now();
    const retrieved = await this.retrieve(question, user, topK);
    const citations: RagCitation[] = retrieved.hits.map((h, i) => ({
      index: i + 1,
      itemId: h.itemId,
      danghao: h.danghao,
      title: h.title,
      chunkNo: h.chunkNo,
      snippet: h.content.slice(0, 200),
    }));

    if (retrieved.hits.length === 0) {
      return {
        answer: '未在您有权访问的档案中找到与该问题相关的内容。可尝试更换关键词，或确认该档案是否已开放/抽取出全文。',
        citations: [],
        mode: retrieved.mode,
        model: null,
        tookMs: Date.now() - started,
        degraded: true,
        note: retrieved.note,
      };
    }

    const context = retrieved.hits
      .map((h, i) => `[${i + 1}] 档号：${h.danghao}｜题名：${h.title}\n${h.content.slice(0, 700)}`)
      .join('\n\n');

    const system =
      '你是档案查询助手。只能依据给定的档案片段回答，禁止使用片段以外的知识或推测。' +
      '回答末尾用 [序号] 标注依据的片段；片段不足以回答时直接说明缺少哪些信息。' +
      '保持客观、简洁，使用中文。';

    {
      try {
        const ok = await this.llm.available();
        if (ok) {
          const answer = await this.llm.chat(system, `档案片段：\n${context}\n\n问题：${question}`);
          if (answer) {
            return {
              answer,
              citations,
              mode: retrieved.mode,
              model: this.llm.model,
              tookMs: Date.now() - started,
              degraded: false,
              note: retrieved.note,
            };
          }
        }
      } catch (err) {
        this.logger.warn(`生成失败，降级为抽取式摘要：${(err as Error).message}`);
      }
    }

    // 抽取式降级：把最相关的前 3 段直接给出，并明示「未经模型归纳」
    const extractive = retrieved.hits
      .slice(0, 3)
      .map((h, i) => `[${i + 1}] ${h.danghao}《${h.title}》：${h.content.slice(0, 260)}…`)
      .join('\n\n');
    return {
      answer: `（生成模型不可用，以下为检索到的原文摘录，未经归纳）\n\n${extractive}`,
      citations,
      mode: retrieved.mode,
      model: null,
      tookMs: Date.now() - started,
      degraded: true,
      note:
        retrieved.note ??
        `生成模型 ${this.llm.model} 不可用；配置 LLM_BASE_URL 后可获得综述式回答`,
    };
  }

  // ==========================================================================
  // 建库
  // ==========================================================================

  /**
   * 建立/重建向量索引。
   *
   * @param options.ids    指定条目（为空则自动挑「尚未建块」的条目）
   * @param options.limit  本次最多处理条目数（分批调用，避免长事务与超时）
   */
  public async reindex(options: {
    ids?: string[];
    limit?: number;
    force?: boolean;
  }): Promise<RagReindexResult> {
    const started = Date.now();
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const ids = (options.ids ?? []).filter(Boolean);

    const params: unknown[] = [];
    let where: string;
    if (ids.length > 0) {
      params.push(ids);
      where = `i.id = ANY($1::uuid[])`;
    } else if (options.force) {
      where = `TRUE`;
    } else {
      // 自动模式只挑「还没有任何块」的条目，避免每次全量重算
      where = `NOT EXISTS (SELECT 1 FROM item_chunk c WHERE c.item_id = i.id)`;
    }

    const items: Array<{
      id: string;
      danghao: string;
      title: string;
      security_level: string;
      fonds_id: string;
      body: string | null;
    }> = await this.dataSource.query(
      `SELECT i.id, i.danghao, i.title, i.security_level, i.fonds_id,
              COALESCE(
                (SELECT string_agg(dt.content, E'\n' ORDER BY dt.version DESC)
                   FROM document_text dt WHERE dt.item_id = i.id),
                (SELECT string_agg(kb.chunk, E'\n' ORDER BY kb.chunk_no)
                   FROM kb_entry kb WHERE kb.item_id = i.id),
                i.full_text
              ) AS body
         FROM archive_item i
        WHERE i.deleted = FALSE AND ${where}
        ORDER BY i.updated_at DESC
        LIMIT ${limit}`,
      params,
    );

    const result: RagReindexResult = {
      items: 0,
      chunks: 0,
      skipped: 0,
      failed: 0,
      tookMs: 0,
    };
    if (items.length === 0) {
      return { ...result, tookMs: Date.now() - started };
    }

    const kind = await this.detectStore();
    const embedAvailable = await this.embedding.health();

    for (const item of items) {
      const body = (item.body ?? '').trim();
      if (body.length === 0) {
        result.skipped += 1;
        continue;
      }
      try {
        // 先清旧块（重建幂等）；分块参数与 kb_entry 一致，避免两套口径
        await this.dataSource.query(`DELETE FROM item_chunk WHERE item_id = $1`, [item.id]);
        const chunks = chunkText(body, { target: 400, max: 600, overlap: 80 }).slice(
          0,
          this.maxChunksPerItem,
        );
        if (chunks.length === 0) {
          result.skipped += 1;
          continue;
        }

        let vectors: number[][] | null = null;
        if (embedAvailable) {
          // 分批 8 条：单次请求过大在 GPU 上容易触发 timeout（实测 20 条会 abort），
          // 批次小一点虽然往返多，但整体成功率与耗时都更优。
          vectors = [];
          for (let i = 0; i < chunks.length; i += 8) {
            const batch = chunks.slice(i, i + 8).map((c) => c.text);
            vectors.push(...(await this.embedding.embed(batch)));
          }
        }

        for (let i = 0; i < chunks.length; i += 1) {
          const vec = vectors?.[i] ?? null;
          const embeddingExpr =
            vec === null ? null : kind === 'PGVECTOR' ? OllamaEmbeddingProvider.literal(vec) : vec;
          await this.dataSource.query(
            kind === 'PGVECTOR'
              ? `INSERT INTO item_chunk (item_id, chunk_no, content, char_len, embedding, security_level, fonds_id)
                 VALUES ($1, $2, $3, $4, $5::vector, $6, $7)`
              : `INSERT INTO item_chunk (item_id, chunk_no, content, char_len, embedding, security_level, fonds_id)
                 VALUES ($1, $2, $3, $4, $5::float8[], $6, $7)`,
            [
              item.id,
              chunks[i].chunkNo,
              chunks[i].text,
              chunks[i].charLen,
              embeddingExpr,
              item.security_level,
              item.fonds_id,
            ],
          );
        }
        result.items += 1;
        result.chunks += chunks.length;
      } catch (err) {
        result.failed += 1;
        this.logger.error(`建立向量块失败 ${item.danghao}: ${(err as Error).message}`);
      }
    }

    result.tookMs = Date.now() - started;
    this.logger.log(
      `向量建库：${result.items} 件 / ${result.chunks} 块（跳过 ${result.skipped}，失败 ${result.failed}）耗时 ${result.tookMs}ms`,
    );
    return result;
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private toHit(r: Record<string, unknown>): RagChunkHit {
    return {
      chunkId: String(r.id),
      itemId: String(r.item_id),
      danghao: String(r.danghao ?? ''),
      title: String(r.title ?? ''),
      chunkNo: Number(r.chunk_no ?? 0),
      content: String(r.content ?? ''),
      score: Number(r.score ?? 0),
      securityLevel: String(r.security_level ?? 'PUBLIC') as SecurityLevel,
    };
  }

  /** 余弦相似度（仅数组回退路径使用；向量已 L2 归一化时可退化为点积） */
  private cosine(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /** 中文 2-gram 切片（保留原串整体，避免短查询被切碎后失去精度） */
  private ngrams(query: string): string[] {
    const q = query.replace(/\s+/g, ' ').trim();
    const set = new Set<string>();
    if (q.length <= 2) {
      set.add(q);
      return [...set];
    }
    // 按空格分词后，对每个词取 2-gram；整串也保留一次
    for (const token of q.split(' ')) {
      if (token.length <= 2) {
        set.add(token);
        continue;
      }
      for (let i = 0; i + 2 <= token.length; i += 2) {
        set.add(token.slice(i, i + 2));
      }
    }
    if (set.size === 0) set.add(q);
    return [...set].slice(0, 16);
  }
}
