import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SecurityLevel,
  type KbCitation,
  type KbQueryRequest,
  type KbQueryResponse,
  type PermissionSnapshot,
  BizException,
  ErrorCode,
} from '@tianji/shared';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';
import { VECTOR_STORE } from './vector.store';

/** 向量检索命中项 */
export interface VectorHit {
  entryId: string;
  itemId: string;
  danghao: string;
  securityLevel: SecurityLevel;
  chunk: string;
  score: number;
}

/** 向量存储接口（P2 换 ES kNN / pgvector 时实现保持不变） */
export interface VectorStore {
  readonly name: string;
  upsert(entries: KbEntry[]): Promise<number>;
  search(
    queryVector: number[],
    options: { topK: number; user: PermissionSnapshot },
  ): Promise<VectorHit[]>;
  deleteByItem(itemId: string): Promise<number>;
}

/**
 * KB 检索服务（P2 预留能力，P0 契约 + 可运行实现）。
 *
 * 硬性约束（验收要点 3）：检索前必须经 `applyAccessFilter` 过滤，
 * 本服务即使只是骨架也完整实现密级 + 数据范围过滤，绝不返回越权片段。
 *
 * 当前对外行为：`/api/kb/query` 返回 501（KB_NOT_ENABLED）并携带候选数量，
 * 便于前端如实提示「知识库未启用」；`/api/kb/status` 返回能力与提供方信息。
 *
 * ⚠️ 501 是防呆闸门，不是占位符：**不得单独移除**。移除前必须同时满足
 * 《RAG知识库立项书》§4 的 G-1~G-4（尤其是"补 chunk 生产者"——没有 chunker 时
 * 即使打开也只会在空表上返回"无依据"，看起来像功能故障）。
 */
@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);

  public constructor(
    @InjectRepository(KbEntry) private readonly entryRepo: Repository<KbEntry>,
    private readonly accessBuilder: AccessFilterBuilder,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly vectorStore: VectorStore,
  ) {}

  /** 能力状态（前端可据此隐藏入口） */
  public async status(user: PermissionSnapshot): Promise<{
    enabled: boolean;
    embeddingProvider: string;
    dimension: number;
    productionReady: boolean;
    indexedChunks: number;
    filter: Record<string, unknown>;
  }> {
    const filter = this.accessBuilder.buildKbFilter(user);
    const indexedChunks = await this.entryRepo.count();
    return {
      enabled: false,
      embeddingProvider: this.embedding.name,
      dimension: this.embedding.dimension,
      productionReady: this.embedding.productionReady,
      indexedChunks,
      filter: { filters: filter.filters },
    };
  }

  /**
   * 问答检索（P0 未启用，抛 501）。
   * 即使未启用，也先完成权限过滤与候选统计，确保契约字段可用、且不泄露越权数据。
   */
  public async query(req: KbQueryRequest, user: PermissionSnapshot): Promise<KbQueryResponse> {
    const question = (req.question ?? '').trim();
    if (question.length < 2) {
      throw BizException.badRequest('问题内容过短');
    }

    // 1) 权限过滤（密级 + 全宗范围），与主检索同一口径
    const filter = this.accessBuilder.buildKbFilter(user);

    // 2) 计算候选条目数（仅统计，不返回内容）
    //    空集合（未知密级 fail-closed）不能用 `IN ()`（PG 语法错误），降级为 `FALSE`。
    //    注意：此处只按密级统计（信息性数值，随 501 一同返回）。完整的数据范围过滤
    //    由 `EsVectorStore.search` 在真正检索时下推到 SQL —— 两处口径同源于
    //    AccessFilterBuilder，不存在第二套判断。
    const allowedLevels = this.accessBuilder.levelsAtMost(user.maxSecurityLevel);
    const countQb = this.entryRepo.createQueryBuilder('k');
    if (allowedLevels.length === 0) {
      countQb.where('FALSE');
    } else {
      countQb.where('k.security_level IN (:...levels)', { levels: allowedLevels });
    }
    const candidates = await countQb.getCount();

    this.logger.log(
      `KB 查询被调用（P2 未启用）：question="${question.slice(0, 30)}…" 候选=${candidates} filters=${JSON.stringify(filter.filters)}`,
    );

    // 3) P0 明确 501，避免前端误以为无结果
    throw new BizException(
      ErrorCode.KB_NOT_ENABLED,
      `知识库问答为 P2 能力，当前版本未启用（已就绪：向量化提供方 ${this.embedding.name}，权限过滤已生效，密级可达片段 ${candidates} 条）`,
    );
  }

  /**
   * 检索召回（P2 内部使用）：向量化 → 权限下推过滤 → topK 打分。
   *
   * 三处历史缺陷在此收口：
   *  - 查询向量与片段向量**同一 provider、同一特征空间**（旧实现另写了一套哈希，
   *    两者余弦无意义）；
   *  - 权限过滤**先于**截断（旧实现先取 500 条最新再过滤，低密级用户会假阴性）；
   *  - 打分由存储层返回真实余弦值（旧实现恒 `score: 0`）。
   */
  public async retrieve(
    question: string,
    user: PermissionSnapshot,
    topK = 5,
  ): Promise<KbCitation[]> {
    const q = (question ?? '').trim();
    if (q.length === 0) return [];

    const vector = await this.embedding.embedOne(q);
    const hits = await this.vectorStore.search(vector, { topK, user });

    return hits.map((h) => ({
      danghao: h.danghao,
      itemId: h.itemId,
      snippet: h.chunk.slice(0, 200),
      securityLevel: h.securityLevel,
    }));
  }

  /**
   * 条目重建索引（P2 使用；当前返回 0）。
   *
   * 说明：真正的重建需要「切块 → 向量化 → 写 kb_entry」，而 chunk 生产者尚未实现
   * （《RAG知识库立项书》§1.2 缺口 D-1）。此处保持"只改状态位"的原语义并**不再
   * 假装**完成重建 —— 无片段时返回 0，不把 `embedding_status` 改成 OK 制造假象。
   */
  public async reindex(itemId: string): Promise<{ indexed: number }> {
    const rows = await this.entryRepo.find({ where: { itemId } });
    if (rows.length === 0) return { indexed: 0 };
    this.logger.warn(
      `KB 重建索引被调用但 chunk 生产者未实现（条目 ${itemId} 现有 ${rows.length} 条片段，未重新向量化）`,
    );
    return { indexed: 0 };
  }
}
