import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SecurityLevel, type PermissionSnapshot } from '@tianji/shared';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { applyAccessFilter } from '../../common/access/scoped-query';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';
import type { ChunkHit, ChunkRetriever } from './kb.retriever';

/** 扫描分页大小（控制单次内存占用；不影响召回正确性） */
const PAGE_SIZE = 256;

/**
 * 向量片段检索（B 档路径）：PG 权威片段表 + 权限下推 + 逐页扫描余弦。
 *
 * ## 何时被使用
 *
 * 仅当 `EmbeddingProvider.productionReady === true` 时由 `kb.module.ts` 的工厂选中。
 * 当前默认提供方（`LocalHashEmbeddingProvider`）为 `false`，故本实现处于**待命**状态，
 * 检索走 `LexicalChunkRetriever`。这不是死代码：是否启用只取决于 provider 的能力声明。
 *
 * 为什么在 hash 提供方下也不用它：字符 2-gram 哈希没有语义能力，用它排序会把
 * 无关片段排到前面——那比"词法命中"更糟，因为它看起来像语义检索。
 *
 * ## D-2 教训（已固化在此实现中）
 *
 * 查询向量与片段向量必须出自**同一** provider、同一特征空间。旧实现另写了一套
 * `hashOf` 与 provider 混用，余弦值等于噪声；维度不一致时还会用 `min()` 截断比较，
 * 静默算出"看起来正常"的相似度——故此处维度不一致直接抛错。
 *
 * ## 已知边界
 *
 * - 逐页扫描是 O(n)，不是 ANN 索引；片段量级大时应换 ES `dense_vector` kNN 或 pgvector。
 * - `applyAccessFilter` 对 ORG 范围会生成 `"org_id"` 条件，而 `archive_item` 无该列
 *   （机构归属在 `volume.org_id`）——与主检索同源缺口，单独登记，不在此私修。
 */
@Injectable()
export class EsVectorStore implements ChunkRetriever {
  public readonly name = 'pg-vector-scan';
  public readonly mode = 'vector' as const;
  private readonly logger = new Logger(EsVectorStore.name);

  public constructor(
    @InjectRepository(KbEntry) private readonly repo: Repository<KbEntry>,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
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

    const queryVector = await this.embedding.embedOne(q);
    if (queryVector.length !== this.embedding.dimension) {
      throw new Error(
        `KB 向量维度不一致：query=${queryVector.length} provider=${this.embedding.dimension}（换模型须全量重建索引）`,
      );
    }

    const qb = this.repo
      .createQueryBuilder('k')
      .innerJoin(ArchiveItem, 'a', 'a.id = k.item_id')
      .select([
        'k.id',
        'k.item_id',
        'k.source_danghao',
        'k.security_level',
        'k.chunk',
        'k.chunk_no',
      ]);

    // 权限条件先落 SQL（security_level / 数据范围 / a.deleted = FALSE）
    applyAccessFilter(qb, this.accessBuilder, user, 'a');

    const best: Array<{ row: KbEntry; score: number }> = [];
    let offset = 0;
    let scanned = 0;

    for (;;) {
      const page = await qb.skip(offset).take(PAGE_SIZE).getMany();
      if (page.length === 0) break;

      // 批量向量化：与查询向量同一 provider、同一特征空间
      const vectors = await this.embedding.embed(page.map((r) => r.chunk));
      for (let i = 0; i < page.length; i += 1) {
        insertTop(best, { row: page[i], score: cosine(queryVector, vectors[i] ?? []) }, limit);
      }

      scanned += page.length;
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    this.logger.debug(`KB 向量召回：扫描 ${scanned} 条已授权片段，返回 ${best.length} 条`);

    // `k.security_level` 是索引快照，回显前换成 archive_item 真值
    const trueLevels = await this.loadTrueLevels(best.map((s) => s.row.itemId));
    return best.map((s) => ({
      itemId: s.row.itemId,
      danghao: s.row.sourceDanghao,
      securityLevel: trueLevels.get(s.row.itemId) ?? (s.row.securityLevel as SecurityLevel),
      chunkNo: s.row.chunkNo,
      snippet: s.row.chunk.slice(0, 200),
      score: s.score,
    }));
  }

  /**
   * 回查条目密级真值（与词法路径同口径）。
   *
   * 权限过滤已在前一步 SQL 用 `a.security_level` 完成，此处只负责**标签正确**：
   * 片段表里的密级是建索引时的快照，条目升密后、自愈扫描跑到之前会偏松，
   * 直接回显等于把机密件标成公开级。查不到时退回快照值 —— 不会因此放宽权限。
   */
  private async loadTrueLevels(itemIds: string[]): Promise<Map<string, SecurityLevel>> {
    const ids = [...new Set(itemIds)].filter(Boolean);
    if (ids.length === 0) return new Map();
    const rows = (await this.repo.manager
      .getRepository(ArchiveItem)
      .createQueryBuilder('i')
      .select(['i.id AS id', 'i.security_level AS security_level'])
      .where('i.id IN (:...ids)', { ids })
      .getRawMany()) as Array<{ id: string; security_level: SecurityLevel }>;
    return new Map(rows.map((r) => [r.id, r.security_level]));
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
