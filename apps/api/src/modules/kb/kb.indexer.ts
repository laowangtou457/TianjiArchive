import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { chunkText } from '@tianji/shared';
import { KbEsService, type KbChunkEsDoc } from './kb.es';

/** 单次重建/批处理的结果 */
export interface KbIndexResult {
  items: number;
  chunks: number;
  failed: number;
}

/** 参与切块的条目快照 */
interface ItemSourceRow {
  id: string;
  danghao: string;
  security_level: string;
  fonds_id: string | null;
  created_by: string | null;
  deleted: boolean;
  item_full_text: string | null;
  doc_text: string | null;
}

/**
 * 片段索引器 —— 把条目正文切成片段，写入 `kb_entry`（权威）并同步 `kb_chunks`（检索镜像）。
 *
 * ## 正文来源口径（与 extractor 对齐）
 *
 * 优先取 `document_text`（抽取器产物，按文件聚合），回退 `archive_item.full_text`
 * （种子/迁移脚本回填）。原因：`document_text` 是抽取链路的权威正文，
 * `full_text` 只是它的一个派生视图，某些历史条目只有后者。
 *
 * ## 幂等
 *
 * 同一 `item_id` 重建 = 先删后插（PG 事务内 delete，ES delete_by_query + 幂等 upsert
 * `itemId:chunkNo`）。唯一索引 `uk_kb_item_chunk` 让"漏删导致叠加"变成硬报错，
 * 而不是静默脏数据。
 *
 * ## 密级从哪来
 *
 * **只从 `archive_item.security_level` 取，绝不从文本推断。** 片段密级与条目密级
 * 不一致就是越权入口，因此重建时整体覆盖，不做"保留旧值"的优化。
 *
 * ## 已知边界
 *
 * - `archive_item` 无 `org_id`，故 ES 文档 `orgId` 恒为 null → ORG 型数据范围授权
 *   的用户检索不到片段（与主检索同源缺口，单独登记）。
 * - 密级变更后不会自动重切：由 `KbScheduler` 的陈旧扫描自愈（比对条目密级与片段密级）。
 */
@Injectable()
export class KbIndexer {
  private readonly logger = new Logger(KbIndexer.name);

  /** 取正文的 SQL 片段（两处复用，避免口径漂移） */
  private static readonly SOURCE_SQL = `
    SELECT i.id,
           i.danghao,
           i.security_level::text AS security_level,
           i.fonds_id,
           i.created_by,
           i.deleted,
           i.full_text AS item_full_text,
           (SELECT string_agg(dt.content, E'\\n' ORDER BY dt.file_id)
              FROM document_text dt WHERE dt.item_id = i.id) AS doc_text
      FROM archive_item i
  `;

  public constructor(
    private readonly dataSource: DataSource,
    private readonly es: KbEsService,
  ) {}

  /** 单条目重建；返回写入的片段数（正文为空则为 0，并清掉旧片段） */
  public async indexItem(itemId: string): Promise<number> {
    const rows = (await this.dataSource.query(
      `${KbIndexer.SOURCE_SQL} WHERE i.id = $1`,
      [itemId],
    )) as ItemSourceRow[];
    const row = rows[0];
    if (!row) {
      // 条目已硬删：清残留片段
      await this.purgeItem(itemId);
      return 0;
    }

    const text = (row.doc_text ?? '').trim() || (row.item_full_text ?? '').trim();
    const chunks = chunkText(text);

    // 1) PG 权威表：事务内先删后插
    await this.dataSource.transaction(async (m) => {
      await m.query(`DELETE FROM kb_entry WHERE item_id = $1`, [itemId]);
      for (let i = 0; i < chunks.length; i += 1) {
        const c = chunks[i];
        await m.query(
          `INSERT INTO kb_entry
             (item_id, source_danghao, security_level, chunk, chunk_no, version, embedding_status)
           VALUES ($1, $2, $3, $4, $5, 1, 'NONE')`,
          [itemId, row.danghao, row.security_level, c.text, c.chunkNo],
        );
      }
    });

    // 2) ES 镜像：先清该条目旧片段，再批量写（_id 幂等）
    await this.es.deleteByItem(itemId);
    const docs: KbChunkEsDoc[] = chunks.map((c) => ({
      id: `${itemId}:${c.chunkNo}`,
      itemId,
      danghao: row.danghao,
      securityLevel: row.security_level,
      fondsId: row.fonds_id,
      orgId: null,
      createdBy: row.created_by,
      deleted: row.deleted,
      chunkNo: c.chunkNo,
      chunk: c.text,
    }));
    await this.es.bulkIndex(docs);

    return chunks.length;
  }

  /** 批量重建（单条失败不中断整批，计入 failed） */
  public async indexItems(itemIds: string[]): Promise<KbIndexResult> {
    let items = 0;
    let chunks = 0;
    let failed = 0;
    for (const id of itemIds) {
      try {
        const n = await this.indexItem(id);
        items += 1;
        chunks += n;
      } catch (err) {
        failed += 1;
        this.logger.error(`片段重建失败 item=${id}: ${(err as Error).message}`);
      }
    }
    return { items, chunks, failed };
  }

  /** 删除某条目的全部片段（PG + ES） */
  public async purgeItem(itemId: string): Promise<number> {
    const r = await this.dataSource.query(
      `DELETE FROM kb_entry WHERE item_id = $1 RETURNING 1 AS hit`,
      [itemId],
    );
    const deleted = Array.isArray(r) ? r.length : 0;
    await this.es.deleteByItem(itemId);
    return deleted;
  }

  /**
   * 找出需要（重）建索引的条目：无片段，或片段密级与条目密级不一致。
   *
   * 这条查询同时覆盖三种情况，是"自愈式"增量方案的核心：
   *   ① 新入库/新抽取完成 → 无片段；
   *   ② 密级被改（`updateItem`/`batchUpdate` 支持改密级）→ 密级不一致；
   *   ③ 有正文但历史上从未建过索引（升级前的老数据）→ 无片段。
   * 软删除条目被排除（检索侧另有 `deleted=false` 过滤，恢复后重新扫描自然重新入列）。
   */
  public async findStaleItemIds(limit = 200): Promise<string[]> {
    const cap = Math.min(2000, Math.max(1, Math.floor(limit)));
    const rows = (await this.dataSource.query(
      `SELECT i.id
         FROM archive_item i
         LEFT JOIN LATERAL (
           SELECT count(*) AS c, min(k.security_level::text) AS lvl
             FROM kb_entry k WHERE k.item_id = i.id
         ) s ON TRUE
        WHERE i.deleted = FALSE
          AND (s.c = 0 OR s.lvl IS DISTINCT FROM i.security_level::text)
          AND (
                COALESCE(NULLIF(btrim(i.full_text), ''), '') <> ''
             OR EXISTS (SELECT 1 FROM document_text dt WHERE dt.item_id = i.id)
          )
        ORDER BY i.updated_at ASC
        LIMIT $1`,
      [cap],
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** 已索引片段总数（供 /api/kb/status） */
  public async countChunks(): Promise<number> {
    const rows = (await this.dataSource.query(`SELECT count(*)::int AS n FROM kb_entry`)) as Array<{
      n: number;
    }>;
    return rows[0]?.n ?? 0;
  }

  /** 某条目的片段数（重建后回读校验用） */
  public async countChunksOfItem(itemId: string): Promise<number> {
    const rows = (await this.dataSource.query(
      `SELECT count(*)::int AS n FROM kb_entry WHERE item_id = $1`,
      [itemId],
    )) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  /** 全量重建的条目清单（仅未软删且有正文者；`--all` 用） */
  public async listAllItemIdsWithText(): Promise<string[]> {
    const rows = (await this.dataSource.query(
      `SELECT i.id
         FROM archive_item i
        WHERE i.deleted = FALSE
          AND (
                COALESCE(NULLIF(btrim(i.full_text), ''), '') <> ''
             OR EXISTS (SELECT 1 FROM document_text dt WHERE dt.item_id = i.id)
          )
        ORDER BY i.updated_at ASC`,
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
