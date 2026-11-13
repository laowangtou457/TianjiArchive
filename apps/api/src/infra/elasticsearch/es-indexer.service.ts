import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ArchiveItem } from '../database/entities/archive-item.entity';
import { ElectronicFile } from '../database/entities/electronic-file.entity';
import { RedisService } from '../redis/redis.module';
import { EsService } from './es.service';
import type { ArchiveEsDoc } from './es.types';

/**
 * 档案条目 → ES 索引的同步器。
 *
 * ## 为什么需要这个服务
 *
 * 索引同步原本写在 SearchService.syncItemToEs 里，但**没有任何调用方**，
 * 导致 ES 索引长期停在初始化时的 6 个文档上，3469 件档案「搜不到」而
 * PG 里明明有。检索慢和召不回不是调优问题，是数据根本没进索引。
 *
 * 所以把同步职责下沉到 infra 层：
 *   - 归档模块只依赖 infra，不与检索模块形成环；
 *   - 写入侧统一走 `enqueue()`，攒批合并后一次 bulk，避免逐件 HTTP 往返；
 *   - 失败只告警不抛（索引滞后由定时对账 + 手工重建兜底，不能反过来拖垮归档）。
 *
 * ## 一致性口径
 *
 * ES 是**派生数据**，PG 是唯一真值。因此：
 *   - 同步失败不回滚业务事务（归档成功就是成功，索引稍后追平）；
 *   - 检索侧仍要过 AccessFilterBuilder 做权限真值校验（KB 检索已是两段式），
 *     不能把 ES 里的密级快照当成授权依据。
 */
@Injectable()
export class EsIndexerService implements OnModuleDestroy {
  private readonly logger = new Logger(EsIndexerService.name);

  /** 待同步的条目 id（Set 去重：同一条目连续改多次只同步最后一次） */
  private readonly pending = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  /** 攒批窗口：批量操作时把 N 次单件同步合并成 1 次 bulk */
  private static readonly FLUSH_DELAY_MS = 300;
  private static readonly FLUSH_MAX = 300;
  /**
   * 单文档全文上限（字符数）。
   *
   * 一部几十万字的书全文进单文档会让 bulk 请求单体膨胀，ES 协调节点按
   * coordinating_operation_bytes 直接拒绝（实测 60MB 即触发 es_rejected_execution_exception）。
   * 50 万字符≈1.5MB，已覆盖绝大多数档案正文；超出部分对检索召回边际收益极低，
   * 完整原文仍在对象存储与 document_text 里，不损失可读性。
   */
  private static readonly FULLTEXT_MAX_CHARS = 500_000;

  constructor(
    private readonly es: EsService,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(ElectronicFile) private readonly fileRepo: Repository<ElectronicFile>,
    private readonly redis: RedisService,
  ) {}

  // ==========================================================================
  // 入队与合并刷盘
  // ==========================================================================

  /** 登记一个待同步条目（非阻塞，非阻塞式 fire-and-forget） */
  public enqueue(itemId: string | null | undefined): void {
    if (!itemId) return;
    this.pending.add(itemId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, EsIndexerService.FLUSH_DELAY_MS);
    // 不因等待刷盘而阻止进程退出
    this.flushTimer.unref?.();
  }

  /** 批量登记 */
  public enqueueMany(itemIds: ReadonlyArray<string | null | undefined>): void {
    for (const id of itemIds) this.enqueue(id);
  }

  /** 立即把队列里的条目写入 ES */
  public async flush(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    const ids = Array.from(this.pending).slice(0, EsIndexerService.FLUSH_MAX);
    for (const id of ids) this.pending.delete(id);
    try {
      await this.syncItems(ids);
    } catch (err) {
      this.logger.warn(`ES 批量同步失败（${ids.length} 件）: ${(err as Error).message}`);
    } finally {
      this.flushing = false;
      // 还有余量就继续下一批
      if (this.pending.size > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, 0);
        this.flushTimer.unref?.();
      }
    }
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pending.size > 0) await this.flush();
  }

  // ==========================================================================
  // 写入
  // ==========================================================================

  /** 单件立即同步（抽取完成等强实时场景用） */
  public async syncItem(itemId: string): Promise<void> {
    await this.syncItems([itemId]);
  }

  /** 批量同步：一次 PG 查询 + 一次 bulk */
  public async syncItems(itemIds: string[]): Promise<void> {
    const ids = [...new Set(itemIds)].filter(Boolean);
    if (ids.length === 0) return;

    const rows = await this.itemRepo.find({ where: { id: In(ids) } });
    if (rows.length === 0) return;

    const fileCounts = await this.countFiles(rows.map((r) => r.id));
    const fulltextMap = await this.loadFulltexts(rows);

    const docs: ArchiveEsDoc[] = rows.map((item) =>
      this.toDoc(item, fileCounts.get(item.id) ?? 0, fulltextMap.get(item.id) ?? item.fullText ?? ''),
    );

    const result = await this.es.bulkIndex(docs);
    if (result.errors > 0) {
      this.logger.warn(`ES 同步部分失败 ${result.errors}/${docs.length}`);
    }
    // 索引变了就让检索缓存整体换版本：旧 key 带旧版本号，读不到即自然淘汰。
    // 比 SCAN 删键便宜，也避免「删到一半」的中间态。
    await this.bumpSearchVersion();
  }

  /** 检索缓存版本号 +1（Redis 不可用时静默跳过，缓存靠 TTL 兜底） */
  private async bumpSearchVersion(): Promise<void> {
    try {
      await this.redis.incr('tj:search:ver');
    } catch (err) {
      this.logger.warn(`检索缓存版本号递增失败（不影响索引写入）: ${(err as Error).message}`);
    }
  }

  /** 条目不存在的场景（物理删除后）显式删文档 */
  public async removeDoc(itemId: string): Promise<void> {
    try {
      await this.es.deleteDoc(itemId);
    } catch (err) {
      this.logger.warn(`ES 删除文档失败 item=${itemId}: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // 自愈扫描
  // ==========================================================================

  /**
   * 每 5 分钟把「最近 20 分钟内变更过」的条目重新同步一遍。
   *
   * 为什么需要它：`enqueue` 是尽力而为的内存队列，进程重启、ES 抖动、ES 拒绝写入
   * 都会让某次同步悄悄丢掉（只留一行 warn）。索引一旦漏条，用户就会遇到
   * 「明明刚录入却搜不到」——比慢更难解释。定期重投近 20 分钟的变更，
   * 是成本最低的收敛手段（单轮最多 500 件，只发 bulk，不查全文以外的东西）。
   *
   * 注意：绕过 API 直接 UPDATE 数据库（含改 deleted）不会带 updated_at 变化时
   * 无法被扫到，这类操作需要手工调 POST /api/search/reindex。
   */
  @Cron('30 */5 * * * *', { name: 'es-index-sweep' })
  public async sweepRecent(): Promise<void> {
    try {
      const rows: Array<{ id: string }> = await this.itemRepo.query(
        `SELECT id FROM archive_item
          WHERE updated_at > now() - interval '20 minutes'
          ORDER BY updated_at DESC LIMIT 500`,
      );
      if (rows.length === 0) return;
      await this.syncItems(rows.map((r) => r.id));
      this.logger.debug(`索引自愈：重投 ${rows.length} 件近期变更`);
    } catch (err) {
      this.logger.warn(`索引自愈扫描失败（不影响检索）: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // 全量重建
  // ==========================================================================

  /**
   * 全量重建索引（keyset 分页，避免深分页）。
   *
   * @param batchSize 每批条数与 bulk 批大小一致（500）
   * @param withFulltext 是否从 kb_entry 回填全文（首次建库与全文上线时为 true）
   */
  public async reindexAll(batchSize = 50, withFulltext = true): Promise<{ indexed: number }> {
    let lastId: string | null = null;
    let indexed = 0;

    for (;;) {
      const qb = this.itemRepo
        .createQueryBuilder('i')
        .where('i.deleted = FALSE')
        .orderBy('i.id', 'ASC')
        .take(batchSize);
      if (lastId) qb.andWhere('i.id > :lastId', { lastId });
      const rows = await qb.getMany();
      if (rows.length === 0) break;

      const fileCounts = await this.countFiles(rows.map((r) => r.id));
      const fulltextMap = withFulltext ? await this.loadFulltexts(rows) : new Map<string, string>();
      const docs = rows.map((item) =>
        this.toDoc(item, fileCounts.get(item.id) ?? 0, fulltextMap.get(item.id) ?? item.fullText ?? ''),
      );

      const r = await this.bulkWithBackoff(docs);
      indexed += r.indexed;
      lastId = rows[rows.length - 1].id;

      if (indexed % 2000 === 0 || rows.length < batchSize) {
        this.logger.log(`ES 重建进度 ${indexed} 件…`);
      }
    }

    await this.es.refresh();
    this.logger.log(`ES 重建完成：${indexed} 件`);
    return { indexed };
  }

  /**
   * 从 kb_entry（RAG 切片）回填 archive_item.full_text。
   *
   * 灌库时文本进了知识库切片却漏了著录的 full_text，导致「库里有文本、检索无全文」。
   * 只填空值，不覆盖人工/抽取器已写入的全文。
   */
  public async backfillFulltext(batchSize = 100): Promise<{ filled: number }> {
    let filled = 0;
    for (;;) {
      const rows: Array<{ id: string }> = await this.itemRepo.query(
        `UPDATE archive_item i
            SET full_text = kb.txt, updated_at = now()
           FROM (
             SELECT item_id, string_agg(chunk, E'\\n' ORDER BY chunk_no) AS txt
               FROM kb_entry GROUP BY item_id
           ) kb
          WHERE kb.item_id = i.id
            AND (i.full_text IS NULL OR i.full_text = '')
            AND i.deleted = FALSE
            AND i.id IN (
              SELECT i2.id FROM archive_item i2
               WHERE (i2.full_text IS NULL OR i2.full_text = '') AND i2.deleted = FALSE
               ORDER BY i2.id LIMIT $1
            )
        RETURNING i.id`,
        [batchSize],
      );
      if (rows.length === 0) break;
      filled += rows.length;
      this.logger.log(`全文回填进度 ${filled} 件…`);
    }
    return { filled };
  }

  /**
   * 带退避的批量写入。
   *
   * 全文文档体积差异极大（几 KB 的文书 vs 几十万字的书），固定批大小会周期性撞上
   * ES 的协调内存阈值。命中拒绝时把本批**二分**重投，而不是整体失败——
   * 否则一部超长书就能让整次重建中断。
   */
  private async bulkWithBackoff(
    docs: ArchiveEsDoc[],
    depth = 0,
  ): Promise<{ indexed: number; errors: number }> {
    try {
      return await this.es.bulkIndex(docs);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const rejected = /rejected|429|too_many_requests/i.test(msg);
      if (!rejected || depth >= 4 || docs.length <= 1) throw err;
      await new Promise((r) => setTimeout(r, 300 * (depth + 1)));
      const mid = Math.floor(docs.length / 2);
      this.logger.warn(`ES 拒绝批量写入（${docs.length} 件），二分重投 depth=${depth + 1}`);
      const a = await this.bulkWithBackoff(docs.slice(0, mid), depth + 1);
      const b = await this.bulkWithBackoff(docs.slice(mid), depth + 1);
      return { indexed: a.indexed + b.indexed, errors: a.errors + b.errors };
    }
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private toDoc(item: ArchiveItem, fileCount: number, fulltext: string): ArchiveEsDoc {
    return {
      id: item.id,
      danghao: item.danghao,
      title: item.title,
      responsible: item.responsible,
      docNo: item.docNo,
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      note: item.note,
      fulltext: fulltext.slice(0, EsIndexerService.FULLTEXT_MAX_CHARS),
      fondsId: item.fondsId,
      orgId: null,
      volumeId: item.volumeId,
      year: item.year,
      retention: item.retention,
      securityLevel: item.securityLevel,
      categoryCode: item.categoryCode,
      classNo: item.classNo,
      status: item.status,
      openFlag: item.openFlag,
      docDate: item.docDate,
      createdAt: new Date(item.createdAt).toISOString(),
      updatedAt: new Date(item.updatedAt).toISOString(),
      createdBy: item.createdBy,
      deleted: item.deleted,
      fileCount,
      hasPreview: fileCount > 0,
    };
  }

  /** 批量取附件数（避免逐件 count） */
  private async countFiles(itemIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (itemIds.length === 0) return map;
    const rows: Array<{ item_id: string; cnt: string }> = await this.fileRepo.query(
      `SELECT item_id, COUNT(*)::text AS cnt FROM electronic_file WHERE item_id = ANY($1::uuid[]) GROUP BY item_id`,
      [itemIds],
    );
    for (const r of rows) map.set(r.item_id, Number.parseInt(r.cnt, 10));
    return map;
  }

  /**
   * 批量取全文，三级来源按可信度取：
   *   1) document_text —— 抽取器的产物（上传附件的正文），最权威；
   *   2) kb_entry —— 灌库时的 RAG 切片文本（老库只有这里）；
   *   3) archive_item.full_text —— 人工编辑或历史写入。
   *
   * 顺序不能颠倒：抽取器只写 document_text 与 ES、不回写 archive_item.full_text，
   * 若把 full_text 当首选源，重建索引会把已抽取的全文**清空**。
   */
  private async loadFulltexts(items: ArchiveItem[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const need = items.filter((i) => !i.fullText || i.fullText.trim() === '').map((i) => i.id);
    if (need.length === 0) return map;

    // 1) 附件抽取正文
    try {
      const rows: Array<{ item_id: string; txt: string }> = await this.itemRepo.query(
        `SELECT item_id, string_agg(content, E'\\n' ORDER BY file_id) AS txt
           FROM document_text WHERE item_id = ANY($1::uuid[]) GROUP BY item_id`,
        [need],
      );
      for (const r of rows) map.set(r.item_id, r.txt ?? '');
    } catch (err) {
      this.logger.warn(`读取 document_text 失败（改试知识库切片）: ${(err as Error).message}`);
    }

    // 2) 知识库切片兜底（只补没有正文的条目）
    const missing = need.filter((id) => !map.has(id));
    if (missing.length === 0) return map;
    try {
      const rows: Array<{ item_id: string; txt: string }> = await this.itemRepo.query(
        `SELECT item_id, string_agg(chunk, E'\\n' ORDER BY chunk_no) AS txt
           FROM kb_entry WHERE item_id = ANY($1::uuid[]) GROUP BY item_id`,
        [missing],
      );
      for (const r of rows) map.set(r.item_id, r.txt ?? '');
    } catch (err) {
      this.logger.warn(`读取 kb_entry 全文失败（退化为无全文索引）: ${(err as Error).message}`);
    }
    return map;
  }
}
