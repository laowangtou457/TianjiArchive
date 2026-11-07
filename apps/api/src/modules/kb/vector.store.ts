import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SecurityLevel } from '@tianji/shared';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import type { VectorHit, VectorStore } from './kb.service';

/**
 * ES/PG 向量存储实现（P2 预留）。
 *
 * P0 说明：不引入 pgvector 扩展依赖，使用 kb_entry 表的密级字段配合
 * AccessFilterBuilder 做「权限前置过滤 + 内存余弦」；
 * P2 可替换为 ES kNN（dense_vector）或 pgvector，接口保持不变。
 */
@Injectable()
export class EsVectorStore implements VectorStore {
  public readonly name = 'pg-kb-entry';
  private readonly logger = new Logger(EsVectorStore.name);

  public constructor(
    @InjectRepository(KbEntry) private readonly repo: Repository<KbEntry>,
    private readonly accessBuilder: AccessFilterBuilder,
  ) {}

  /** 写入/更新（P0 只更新状态位） */
  public async upsert(entries: KbEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    await this.repo.save(entries);
    this.logger.debug(`KB 写入 ${entries.length} 条片段`);
    return entries.length;
  }

  /**
   * 向量检索（骨架）：按 allowedItemIds 白名单在库内过滤后返回文本片段。
   * 注意：真实相似度由调用方计算；此处返回未排序结果供上层打分。
   */
  public async search(
    _queryVector: number[],
    options: { topK: number; allowedItemIds: string[] | null },
  ): Promise<VectorHit[]> {
    const qb = this.repo.createQueryBuilder('k');
    if (options.allowedItemIds !== null) {
      if (options.allowedItemIds.length === 0) return [];
      qb.andWhere('k.item_id IN (:...ids)', { ids: options.allowedItemIds });
    }
    const rows = await qb.limit(Math.min(500, Math.max(1, options.topK * 20))).getMany();
    return rows.map((r) => ({
      entryId: r.id,
      itemId: r.itemId,
      danghao: r.sourceDanghao,
      securityLevel: r.securityLevel as SecurityLevel,
      chunk: r.chunk,
      score: 0,
    }));
  }

  /** 删除某条目的全部片段 */
  public async deleteByItem(itemId: string): Promise<number> {
    const res = await this.repo.delete({ itemId });
    return res.affected ?? 0;
  }

  /** 供上层复用的密级白名单（保证与主检索同口径） */
  public allowedLevels(maxLevel: SecurityLevel): SecurityLevel[] {
    return this.accessBuilder.levelsAtMost(maxLevel);
  }
}
