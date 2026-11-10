import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SecurityLevel, type PermissionSnapshot } from '@tianji/shared';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { applyAccessFilter } from '../../common/access/scoped-query';
import { KbEsService } from './kb.es';

/** 片段命中（对外统一形状，屏蔽底层是词法还是向量） */
export interface ChunkHit {
  itemId: string;
  danghao: string;
  securityLevel: SecurityLevel;
  chunkNo: number;
  snippet: string;
  score: number;
}

/**
 * 片段检索器接口。
 *
 * 两种实现按「向量化提供方是否生产可用」自动择一（见 kb.module.ts 的工厂）：
 *   - `LexicalChunkRetriever`：BM25 + IK 词法召回（A 档，当前默认）；
 *   - `EsVectorStore`：向量余弦召回（B 档，需 productionReady=true）。
 */
export interface ChunkRetriever {
  readonly name: string;
  /** `lexical` = 片段检索（不生成答案）；`vector` = 向量召回 */
  readonly mode: 'lexical' | 'vector';
  search(question: string, user: PermissionSnapshot, topK: number): Promise<ChunkHit[]>;
}

/** 检索器注入令牌 */
export const CHUNK_RETRIEVER = 'CHUNK_RETRIEVER';

/**
 * 词法片段检索（A 档）：ES BM25 + IK 召回 → PG 权限真值二次校验 → topK。
 *
 * ## 为什么是"两段式"，而不是只信 ES
 *
 * ES 文档里的 `securityLevel` 是**建索引那一刻**的快照。条目密级被改后、自愈扫描
 * 尚未跑到之前，索引里的密级可能比真实更宽松。若只信 ES filter，就会把已升密的
 * 片段返回给低密级用户 —— **越权**。
 *
 * 所以：ES 负责"能不能召回得快"，PG 负责"能不能给你看"。第二次校验用
 * `applyAccessFilter`（与主检索同一构造器）对命中片段回表核对，**只会剔除、不会增补**；
 * 回显的密级也一并以 PG 为准（索引快照只当"召回线索"，不当"结论"）。
 *
 * ## 顺序不可颠倒（D-3 教训）
 *
 * ES 侧先把权限条件下推（`buildKbFilter`），再做 topK —— 不是先取 topN 再过滤。
 * 二次校验只是兜底，不承担"过滤主责"，否则低密级用户会稳定假阴性。
 */
@Injectable()
export class LexicalChunkRetriever implements ChunkRetriever {
  public readonly name = 'es-bm25-ik';
  public readonly mode = 'lexical' as const;
  private readonly logger = new Logger(LexicalChunkRetriever.name);

  /** 候选放大倍数：为二次校验可能剔除的片段留余量，仍保持 topK 内不空缺 */
  private static readonly CANDIDATE_FACTOR = 3;

  public constructor(
    private readonly es: KbEsService,
    @InjectRepository(KbEntry) private readonly repo: Repository<KbEntry>,
    private readonly accessBuilder: AccessFilterBuilder,
  ) {}

  public async search(
    question: string,
    user: PermissionSnapshot,
    topK: number,
  ): Promise<ChunkHit[]> {
    const q = (question ?? '').trim();
    if (q.length === 0) return [];
    const limit = Math.min(50, Math.max(1, Math.floor(topK || 5)));

    const filter = this.accessBuilder.buildKbFilter(user);
    const { hits } = await this.es.search(
      q,
      filter.filters,
      limit * LexicalChunkRetriever.CANDIDATE_FACTOR,
    );
    if (hits.length === 0) return [];

    const allowed = await this.verifyAccessible(
      hits.map((h) => h.itemId),
      user,
    );

    const result: ChunkHit[] = [];
    for (const h of hits) {
      const level = allowed.get(h.itemId);
      if (!level) continue;
      result.push({
        itemId: h.itemId,
        danghao: h.danghao,
        // 密级回显必须是 PG 真值，不能是 ES 快照（见 verifyAccessible 注释）
        securityLevel: level,
        chunkNo: h.chunkNo,
        snippet: h.chunk,
        score: h.score,
      });
      if (result.length >= limit) break;
    }

    if (result.length < hits.length) {
      this.logger.debug(
        `KB 二次校验剔除 ${hits.length - result.length} 条（索引密级陈旧或条目已删）`,
      );
    }
    return result;
  }

  /**
   * 回表核对权限（真值以 PG 为准），并带回条目**当前**密级。
   *
   * 返回 Map 而不是 Set，是因为"能不能看"和"该标什么密级"必须一起从真值取：
   * ES 里的 `securityLevel` 是建索引那一刻的快照，条目升密后会偏松。只用于过滤
   * 尚可（二次校验兜住了），但若拿去回显给用户，就等于把机密件标成公开级 ——
   * 标签本身也是安全问题。
   *
   * @returns itemId → archive_item.security_level（仅含允许访问的条目）
   */
  public async verifyAccessible(
    itemIds: string[],
    user: PermissionSnapshot,
  ): Promise<Map<string, SecurityLevel>> {
    const ids = [...new Set(itemIds)].filter(Boolean);
    if (ids.length === 0) return new Map();

    const qb = this.repo
      .createQueryBuilder('k')
      .innerJoin(ArchiveItem, 'i', 'i.id = k.item_id')
      .select(['k.item_id AS item_id', 'i.security_level AS security_level'])
      .where('k.item_id IN (:...ids)', { ids });
    // 与主检索同一构造器：密级 + 数据范围 + i.deleted = FALSE
    applyAccessFilter(qb, this.accessBuilder, user, 'i');

    const rows = (await qb.getRawMany()) as Array<{
      item_id: string;
      security_level: SecurityLevel;
    }>;
    return new Map(rows.map((r) => [r.item_id, r.security_level]));
  }
}
