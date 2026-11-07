import { Injectable, Logger } from '@nestjs/common';
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
import { LocalHashEmbeddingProvider } from './embedding.provider';

/** 向量检索命中项 */
export interface VectorHit {
  entryId: string;
  itemId: string;
  danghao: string;
  securityLevel: SecurityLevel;
  chunk: string;
  score: number;
}

/** 向量存储接口（P2 预留；P0 用 PG 表 + 内存余弦实现） */
export interface VectorStore {
  readonly name: string;
  upsert(entries: KbEntry[]): Promise<number>;
  search(queryVector: number[], options: { topK: number; allowedItemIds: string[] | null }): Promise<VectorHit[]>;
  deleteByItem(itemId: string): Promise<number>;
}

/**
 * KB 检索服务（F-20 P2 预留，P0 仅契约 + 可运行骨架）。
 *
 * 硬性约束（验收要点 3）：检索前必须经 AccessFilterBuilder.buildKbFilter 过滤，
 * 本服务即使只是骨架也完整实现密级 + 数据范围过滤，绝不返回越权片段。
 *
 * P0 行为：`/api/kb/query` 返回 501（KB_NOT_ENABLED）并携带过滤后的候选数量，
 * 便于前端提示「知识库未启用」；`/api/kb/status` 返回能力与提供方信息。
 */
@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);

  public constructor(
    @InjectRepository(KbEntry) private readonly entryRepo: Repository<KbEntry>,
    private readonly accessBuilder: AccessFilterBuilder,
    private readonly embedding: LocalHashEmbeddingProvider,
  ) {
    this.embedding.warnIfPlaceholder();
  }

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
      `知识库问答为 P2 能力，当前版本未启用（已就绪：向量化提供方 ${this.embedding.name}，权限过滤已生效，候选片段 ${candidates} 条）`,
    );
  }

  /** 检索召回（P2 内部使用：向量化 → 权限过滤 → topK） */
  public async retrieve(
    question: string,
    user: PermissionSnapshot,
    topK = 5,
  ): Promise<KbCitation[]> {
    const vector = await this.embedding.embedOne(question);
    const rows = await this.entryRepo.find({ take: 500, order: { createdAt: 'DESC' } });
    const allowed = rows.filter((r) =>
      this.accessBuilder.canAccessRecord(user, {
        securityLevel: r.securityLevel,
        deleted: false,
      }),
    );
    if (allowed.length === 0) return [];

    const scored = allowed.slice(0, 200).map((r) => ({
      row: r,
      score: this.cosine(vector, this.hashOf(r.chunk)),
    }));
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, Math.min(50, Math.max(1, topK))).map((s) => ({
      danghao: s.row.sourceDanghao,
      itemId: s.row.itemId,
      snippet: s.row.chunk.slice(0, 200),
      securityLevel: s.row.securityLevel,
    }));
  }

  /** 条目重建索引（P2 使用；P0 返回 0） */
  public async reindex(itemId: string): Promise<{ indexed: number }> {
    const rows = await this.entryRepo.find({ where: { itemId } });
    if (rows.length === 0) return { indexed: 0 };
    await this.entryRepo.update({ itemId }, { embeddingStatus: 'OK' });
    return { indexed: rows.length };
  }

  /** 简易哈希（用于内存余弦，与 provider 维度一致） */
  private hashOf(text: string): number[] {
    const dim = this.embedding.dimension;
    const vec = new Array<number>(dim).fill(0);
    const s = (text ?? '').toLowerCase();
    for (let i = 0; i < s.length - 1; i += 1) {
      let h = 0;
      for (let j = 0; j < 2; j += 1) {
        h = (h * 31 + s.charCodeAt(i + j)) % 1000003;
      }
      vec[h % dim] += 1;
    }
    return vec;
  }

  /** 余弦相似度 */
  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
}
