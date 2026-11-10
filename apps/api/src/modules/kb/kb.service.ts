import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type KbCitation,
  type KbQueryRequest,
  type KbQueryResponse,
  type PermissionSnapshot,
  BizException,
} from '@tianji/shared';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';
import { CHUNK_RETRIEVER, type ChunkRetriever } from './kb.retriever';
import { KbIndexer } from './kb.indexer';
import { KbEsService } from './kb.es';

/**
 * KB 服务 —— 片段检索（A 档）对外入口。
 *
 * ## 能力边界（必须与前端文案一致）
 *
 * 本服务只做**片段检索**：把问题匹配到档案正文的片段，返回"档号 + 原文片段 + 密级"。
 * **不生成任何答案文本**。`answer` 恒为空串、`mode='retrieval'`，前端据此展示
 * "仅返回依据"，而不是把空答案当成故障。
 *
 * 生成式问答（B 档）需本地模型与硬件复核，见《RAG知识库立项书》§4 G-1/G-2。
 *
 * ## 权限（硬性验收要点 3）
 *
 * 检索链路必然经过 `AccessFilterBuilder`：词法路径在 ES 侧下推 filter、再回 PG 二次
 * 校验；向量路径直接在 SQL 里下推。两条路径都不存在"先取全量再过滤"的写法。
 */
@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);

  public constructor(
    private readonly accessBuilder: AccessFilterBuilder,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    @Inject(CHUNK_RETRIEVER) private readonly retriever: ChunkRetriever,
    private readonly indexer: KbIndexer,
    private readonly es: KbEsService,
  ) {}

  /** 能力状态（前端据此决定是否展示入口、如何措辞） */
  public async status(user: PermissionSnapshot): Promise<{
    enabled: boolean;
    embeddingProvider: string;
    dimension: number;
    productionReady: boolean;
    indexedChunks: number;
    retriever: string;
    mode: 'lexical' | 'vector';
    searchReady: boolean;
    filter: Record<string, unknown>;
  }> {
    const filter = this.accessBuilder.buildKbFilter(user);
    const indexedChunks = await this.indexer.countChunks();
    const searchReady = await this.es.ready();
    return {
      // 片段检索可用即视为 enabled；生成式能力另由 mode 表达
      enabled: searchReady,
      embeddingProvider: this.embedding.name,
      dimension: this.embedding.dimension,
      productionReady: this.embedding.productionReady,
      indexedChunks,
      retriever: this.retriever.name,
      mode: this.retriever.mode,
      searchReady,
      filter: { filters: filter.filters },
    };
  }

  /**
   * 片段检索（对外 `/api/kb/query`）。
   *
   * 未命中时返回空 citations + `grounded=false`，由前端提示「无依据」——
   * **绝不返回相似度低但看起来相关的编造内容**（本项目的"不臆造"硬约束）。
   */
  public async query(req: KbQueryRequest, user: PermissionSnapshot): Promise<KbQueryResponse> {
    const question = (req.question ?? '').trim();
    if (question.length < 2) {
      throw BizException.badRequest('问题内容过短');
    }

    const hits = await this.retriever.search(question, user, req.topK ?? 5);
    const citations: KbCitation[] = hits.map((h) => ({
      danghao: h.danghao,
      itemId: h.itemId,
      snippet: h.snippet.slice(0, 200),
      securityLevel: h.securityLevel,
    }));

    this.logger.log(
      `KB 片段检索：question="${question.slice(0, 30)}…" 命中=${citations.length} 检索器=${this.retriever.name}`,
    );

    return {
      answer: '',
      citations,
      grounded: citations.length > 0,
      mode: 'retrieval',
    };
  }

  /**
   * 重建索引。
   *
   * @param itemIds 指定条目；**传空数组表示自动挑选陈旧/未索引条目**（前端按钮用的是这个）。
   */
  public async reindex(itemIds: string[]): Promise<{ indexed: number; items: number; failed: number }> {
    const targets =
      itemIds.length > 0 ? itemIds : await this.indexer.findStaleItemIds(KbService.DEFAULT_BATCH);

    const r = await this.indexer.indexItems(targets);
    if (targets.length > 0) await this.es.refresh();
    this.logger.log(
      `KB 重建：条目 ${r.items}（失败 ${r.failed}），写入片段 ${r.chunks}（目标 ${targets.length}）`,
    );
    return { indexed: r.chunks, items: r.items, failed: r.failed };
  }

  /** 单次自动重建的条目上限（避免一次请求把 API 拖住） */
  private static readonly DEFAULT_BATCH = 200;
}
