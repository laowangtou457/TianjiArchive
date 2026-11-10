import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SecurityLevel, type PermissionSnapshot } from '@tianji/shared';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { applyAccessFilter } from '../../common/access/scoped-query';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';
import type { VectorHit, VectorStore } from './kb.service';

/** 向量存储注入令牌（P2 换 ES kNN / pgvector 实现时只改模块 wiring，不动调用方） */
export const VECTOR_STORE = 'VECTOR_STORE';

/** 扫描分页大小（控制单次内存占用；不影响召回正确性） */
const PAGE_SIZE = 256;

/**
 * KB 向量存储实现（PG 权威元数据 + 权限下推 + 逐页扫描打分）。
 *
 * ## 为什么不是"先取 N 条再过滤"（历史缺陷 D-3，已修）
 *
 * 旧实现 `entryRepo.find({ take: 500, order: { createdAt: 'DESC' } })` 先按入库时间
 * 截断、再在内存里过滤权限。若最近 500 条片段全属高密级，低密级用户的可访问片段
 * 根本进不了窗口 —— **稳定返回 0 命中**，前端显示"无依据"，是假阴性。
 *
 * 现实现把权限条件下推成 SQL 谓词（`applyAccessFilter`，与主检索同一入口），
 * 使"取 topK"发生在"已过滤集合"内。**顺序不可颠倒**：
 * 过滤只允许改「时机」，不允许改「严格度」。
 *
 * ## 为什么 JOIN archive_item 而不是只信 kb_entry.security_level
 *
 * 密级与数据范围（全宗/机构/本人）的权威源是条目本身。JOIN 保证片段密级与条目
 * 密级永远一致，不存在"条目改密级、片段仍是旧值"这类静默越权；也因此不必把
 * fonds_id / org_id / created_by 冗余进 kb_entry。
 *
 * ## 已知边界（不在此处私修，单独登记）
 *
 * - 逐页扫描 + 内存余弦是 **O(n)**，不是 ANN 索引。当前 `kb_entry` 在生产恒为 0 行
 *   （无 chunk 生产者，见《RAG知识库立项书》§1.2），且 `/api/kb/query` 仍返回 501，
 *   故无性能暴露。P2 启用前必须换成 ES `dense_vector` kNN 或 pgvector。
 * - `applyAccessFilter` 对 ORG 范围会生成 `"org_id"` 条件，而 `archive_item` 无该列
 *   （机构归属实际在 `volume.org_id`）—— 这是**主检索同款既有缺口**，本模块选择与
 *   主检索保持同一口径而非另造一套过滤（防漂移）。
 */
@Injectable()
export class EsVectorStore implements VectorStore {
  public readonly name = 'pg-kb-entry';
  private readonly logger = new Logger(EsVectorStore.name);

  public constructor(
    @InjectRepository(KbEntry) private readonly repo: Repository<KbEntry>,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    private readonly accessBuilder: AccessFilterBuilder,
  ) {}

  /**
   * 写入/更新片段（P2 由 chunker 调用；当前无生产者，保留为契约入口）。
   */
  public async upsert(entries: KbEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    await this.repo.save(entries);
    this.logger.debug(`KB 写入 ${entries.length} 条片段`);
    return entries.length;
  }

  /**
   * 向量检索：权限下推 → 逐页扫描 → 余弦打分 → topK。
   *
   * @param queryVector 查询向量（必须与 provider 维度一致）
   * @param options.topK 返回条数上限（1~50，超出收敛）
   * @param options.user 权限快照（密级 + 数据范围，服务端唯一可信来源）
   */
  public async search(
    queryVector: number[],
    options: { topK: number; user: PermissionSnapshot },
  ): Promise<VectorHit[]> {
    const topK = Math.min(50, Math.max(1, Math.floor(options.topK ?? 5)));

    // 维度不一致必须显式失败：若用 min() 截断比较，会静默算出一个"看起来正常"的
    // 相似度 —— 那比报错更坏。
    if (queryVector.length !== this.embedding.dimension) {
      throw new Error(
        `KB 向量维度不一致：query=${queryVector.length} provider=${this.embedding.dimension}（换模型须全量重建索引）`,
      );
    }

    const qb = this.repo
      .createQueryBuilder('k')
      .innerJoin(ArchiveItem, 'a', 'a.id = k.item_id')
      .select(['k.id', 'k.item_id', 'k.source_danghao', 'k.security_level', 'k.chunk']);

    // 权限条件先落 SQL（security_level / 数据范围 / a.deleted = FALSE）
    applyAccessFilter(qb, this.accessBuilder, options.user, 'a');

    const best: Array<{ row: KbEntry; score: number }> = [];
    let offset = 0;
    let scanned = 0;

    for (;;) {
      const page = await qb.skip(offset).take(PAGE_SIZE).getMany();
      if (page.length === 0) break;

      // 批量向量化：与查询向量同一 provider、同一特征空间（历史缺陷 D-2，已修）
      const vectors = await this.embedding.embed(page.map((r) => r.chunk));
      for (let i = 0; i < page.length; i += 1) {
        insertTop(best, { row: page[i], score: cosine(queryVector, vectors[i] ?? []) }, topK);
      }

      scanned += page.length;
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    this.logger.debug(`KB 召回：扫描 ${scanned} 条已授权片段，返回 ${best.length} 条`);
    return best.map((s) => ({
      entryId: s.row.id,
      itemId: s.row.itemId,
      danghao: s.row.sourceDanghao,
      securityLevel: s.row.securityLevel as SecurityLevel,
      chunk: s.row.chunk,
      score: s.score,
    }));
  }

  /** 删除某条目的全部片段（条目硬删时由调用方触发；归档条目 FK 亦为 CASCADE） */
  public async deleteByItem(itemId: string): Promise<number> {
    const res = await this.repo.delete({ itemId });
    return res.affected ?? 0;
  }
}

/** 余弦相似度（两向量须同维；零向量一律 0 分，不返回 NaN） */
function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 维持降序 topK（K 很小，插入排序优于全量排序再截断） */
function insertTop(
  list: Array<{ row: KbEntry; score: number }>,
  item: { row: KbEntry; score: number },
  limit: number,
): void {
  let at = list.length;
  while (at > 0 && list[at - 1].score < item.score) at -= 1;
  if (at >= limit) return;
  list.splice(at, 0, item);
  if (list.length > limit) list.pop();
}
