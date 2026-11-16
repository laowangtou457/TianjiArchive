import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  SECURITY_LEVEL_RANK,
  type PermissionSnapshot,
  type SecurityLevel,
  type WikiImportSourceDto,
  type WikiImportStatusDto,
} from '@tianji/shared';
import { WikiPage } from '../../infra/database/entities/wiki-page.entity';
import { WikiPageVersion } from '../../infra/database/entities/wiki-page-version.entity';
import { WikiSpace } from '../../infra/database/entities/wiki-space.entity';
import { WikiPagesService } from './wiki-pages.service';

/** 空间密级上限顺序 */
const LEVEL_ORDER = ['PUBLIC', 'INTERNAL', 'SECRET'] as const;
/** 案卷标题的固定后缀「 · XX卷（批量录入）」——来源分组的切分依据 */
const VOLUME_SUFFIX = / · .+卷（批量录入）$/;
/** 同一类型多次下载的批次后缀（如 维基文库_epub）——合并进同一空间 */
const BATCH_SUFFIX = /_epub$/;

/**
 * 免费书籍 → Wiki 批量导入。
 *
 * ## 分组规则（用户约定：按书籍类型建空间）
 *
 *   来源类型 = 案卷标题去掉「 · XX卷（批量录入）」后缀，再合并 `_epub` 批次后缀
 *   （如 维基文库_epub → 维基文库）。每个类型一个空间；同类型内密级混合
 *   （裁判文书含涉密卷），页面继承来源条目密级，空间密级 = 该类型最高密级（上限）。
 *
 * ## 内容来源
 *
 *   页面正文取自 item_chunk（建库时已抽取的全文切片），不重读原文件 ——
 *   档案库与 Wiki 共用同一份事实文本。
 *
 * ## 幂等与进度
 *
 *   wiki_page.source_item_id 唯一键去重：中断重跑自动跳过已导入页面；
 *   单例后台任务（模块内状态机），status/cancel 接口可查可停。
 *   每页失败不中断整体，计入 failed 并记 lastError。
 */
@Injectable()
export class WikiImportService {
  private readonly logger = new Logger(WikiImportService.name);

  /** 单例任务状态（模块级唯一，防并发导入） */
  private job: WikiImportStatusDto & { cancelRequested: boolean } = {
    running: false,
    dryRun: false,
    sources: [],
    total: 0,
    done: 0,
    createdPages: 0,
    skipped: 0,
    failed: 0,
    lastError: null,
    currentTitle: null,
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
  };

  constructor(
    @InjectRepository(WikiSpace) private readonly spaceRepo: Repository<WikiSpace>,
    @InjectRepository(WikiPage) private readonly pageRepo: Repository<WikiPage>,
    @InjectRepository(WikiPageVersion) private readonly versionRepo: Repository<WikiPageVersion>,
    private readonly wikiPages: WikiPagesService,
  ) {}

  // ==========================================================================
  // 查询
  // ==========================================================================

  /** 按「书籍类型 × 最高密级」聚合可导入分组（只统计有权访问的条目） */
  public async sources(user: PermissionSnapshot): Promise<WikiImportSourceDto[]> {
    const userRank = SECURITY_LEVEL_RANK[user.maxSecurityLevel];
    const importedRows: Array<{ source_item_id: string }> = await this.pageRepo.query(
      `SELECT source_item_id FROM wiki_page WHERE deleted = FALSE AND source_item_id IS NOT NULL`,
    );
    const imported = new Set(importedRows.map((r) => r.source_item_id));

    // 条目级归属与密级明细（一次取回，内存聚合）
    const itemRows: Array<{ id: string; source: string; level: string }> = await this.pageRepo.query(
      `SELECT i.id, regexp_replace(v.title, $1, '') AS source, i.security_level AS level
         FROM archive_item i
         JOIN volume v ON v.id = i.volume_id
        WHERE i.deleted = FALSE AND v.title LIKE '%（批量录入）'`,
      [VOLUME_SUFFIX.source],
    );
    const groups = new Map<string, { count: number; imported: number; maxRank: number }>();
    for (const it of itemRows) {
      const key = BATCH_SUFFIX.test(it.source) ? it.source.replace(BATCH_SUFFIX, '') : it.source;
      const rank = SECURITY_LEVEL_RANK[it.level as SecurityLevel] ?? 0;
      if (userRank !== undefined && rank > userRank) continue; // 无权条目连「存在性」都不进统计
      const g = groups.get(key) ?? { count: 0, imported: 0, maxRank: 0 };
      g.count += 1;
      if (imported.has(it.id)) g.imported += 1;
      g.maxRank = Math.max(g.maxRank, rank);
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([source, g]) => ({
        source,
        itemCount: g.count,
        importedCount: g.imported,
        maxSecurityLevel: LEVEL_ORDER[g.maxRank] ?? 'PUBLIC',
      }))
      .sort((a, b) => b.itemCount - a.itemCount);
  }

  public status(): WikiImportStatusDto {
    const { cancelRequested: _c, ...rest } = this.job;
    void _c;
    return { ...rest };
  }

  // ==========================================================================
  // 启动 / 取消
  // ==========================================================================

  public start(
    body: { sources: string[]; limitPerGroup?: number; dryRun?: boolean },
    user: PermissionSnapshot,
  ): WikiImportStatusDto {
    if (this.job.running) {
      throw new BizException(ErrorCode.BAD_REQUEST, '已有导入任务在运行，请先等待完成或取消');
    }
    const sources = (body.sources ?? []).filter(Boolean);
    if (sources.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '至少选择一个书籍类型');
    }
    this.job = {
      running: true,
      dryRun: Boolean(body.dryRun),
      sources,
      total: 0,
      done: 0,
      createdPages: 0,
      skipped: 0,
      failed: 0,
      lastError: null,
      currentTitle: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      cancelRequested: false,
    };
    // 后台跑（不 await）：HTTP 立即返回进度快照，前端轮询 status
    void this.run(sources, body.limitPerGroup ?? 0, Boolean(body.dryRun), user).catch((err) => {
      this.logger.error(`导入任务异常终止：${(err as Error).message}`, (err as Error).stack);
      this.job.running = false;
      this.job.lastError = (err as Error).message;
      this.job.finishedAt = new Date().toISOString();
    });
    return this.status();
  }

  public cancel(): WikiImportStatusDto {
    if (this.job.running) this.job.cancelRequested = true;
    return this.status();
  }

  // ==========================================================================
  // 执行
  // ==========================================================================

  private async run(sources: string[], limitPerGroup: number, dryRun: boolean, user: PermissionSnapshot): Promise<void> {
    const started = Date.now();
    try {
      for (const source of sources) {
        if (this.job.cancelRequested) break;
        await this.importGroup(source, limitPerGroup, dryRun, user);
      }
    } finally {
      this.job.running = false;
      this.job.currentTitle = null;
      this.job.finishedAt = new Date().toISOString();
      this.logger.log(
        `Wiki 导入结束（${dryRun ? 'dryRun' : '正式'}）：新建 ${this.job.createdPages} / 跳过 ${this.job.skipped} / 失败 ${this.job.failed}，耗时 ${Math.round((Date.now() - started) / 1000)}s`,
      );
    }
  }

  private async importGroup(
    source: string,
    limitPerGroup: number,
    dryRun: boolean,
    user: PermissionSnapshot,
  ): Promise<void> {
    const itemRows: Array<{
      id: string;
      source: string;
      title: string;
      level: string;
      danghao: string;
      year: number;
      responsible: string | null;
      keywords: string[] | null;
    }> = await this.pageRepo.query(
      `SELECT i.id, regexp_replace(v.title, $1, '') AS source, i.title,
              i.security_level AS level, i.danghao, i.year, i.responsible, i.keywords
         FROM archive_item i
         JOIN volume v ON v.id = i.volume_id
        WHERE i.deleted = FALSE AND v.title LIKE '%（批量录入）'`,
      [VOLUME_SUFFIX.source],
    );
    // 同类型的各下载批次（如 维基文库_epub）并入同一空间
    const items = itemRows.filter((r) => {
      const src = BATCH_SUFFIX.test(r.source) ? r.source.replace(BATCH_SUFFIX, '') : r.source;
      return src === source;
    });

    const userRank = SECURITY_LEVEL_RANK[user.maxSecurityLevel];
    const usable = items.filter((it) => {
      const rank = SECURITY_LEVEL_RANK[it.level as SecurityLevel] ?? 0;
      return userRank !== undefined && rank <= userRank;
    });
    const maxRank = Math.max(0, ...usable.map((u) => SECURITY_LEVEL_RANK[u.level as SecurityLevel] ?? 0));
    const spaceLevel = LEVEL_ORDER[maxRank] ?? 'PUBLIC';
    const selected = limitPerGroup > 0 ? usable.slice(0, limitPerGroup) : usable;
    this.job.total += selected.length;

    if (dryRun) {
      for (const it of selected) {
        if (this.job.cancelRequested) return;
        this.job.done += 1;
        this.job.currentTitle = `${source} / ${it.title}`;
      }
      return;
    }

    // 空间：同类型已有则复用（密级只升不降）
    let space = await this.spaceRepo.findOne({ where: { name: source, deleted: false } });
    if (!space) {
      space = await this.spaceRepo.save(
        this.spaceRepo.create({
          name: source,
          description: `批量导入自免费书籍「${source}」类型（${selected.length} 件）`,
          securityLevel: spaceLevel,
          createdBy: user.userId,
        }),
      );
    } else {
      const capRank = LEVEL_ORDER.indexOf(space.securityLevel as (typeof LEVEL_ORDER)[number]);
      if (capRank < maxRank) {
        space.securityLevel = spaceLevel;
        await this.spaceRepo.save(space);
      }
    }

    // 已导入集合（含其他类型，防重复键冲突）
    const importedIds = new Set(
      (
        await this.pageRepo.query(
          `SELECT source_item_id FROM wiki_page WHERE deleted = FALSE AND source_item_id IS NOT NULL`,
        )
      ).map((r: { source_item_id: string }) => r.source_item_id),
    );

    for (const it of selected) {
      if (this.job.cancelRequested) return;
      this.job.done += 1;
      this.job.currentTitle = `${source} / ${it.title}`;
      try {
        if (importedIds.has(it.id)) {
          this.job.skipped += 1;
          continue;
        }
        // 正文：取该条目的全部全文切片（建库时已抽取，wiki 与档案共用一份事实文本）
        const chunkRows: Array<{ content: string }> = await this.pageRepo.query(
          `SELECT content FROM item_chunk WHERE item_id = $1 AND deleted = FALSE ORDER BY chunk_no`,
          [it.id],
        );
        const bodyText = chunkRows.map((c) => c.content).join('\n\n');
        if (bodyText.trim().length === 0) {
          this.job.skipped += 1;
          continue; // 无全文（如纯图片件），不建空页
        }
        const keywords = Array.isArray(it.keywords) ? it.keywords.filter(Boolean) : [];
        const meta = [
          it.danghao ? `档号：${it.danghao}` : null,
          it.year ? `年度：${it.year}` : null,
          it.responsible ? `责任者：${it.responsible}` : null,
          keywords.length ? `主题词：${keywords.join('、')}` : null,
        ]
          .filter(Boolean)
          .join(' ｜ ');

        const page = await this.pageRepo.save(
          this.pageRepo.create({
            spaceId: space.id,
            parentId: null,
            title: this.cleanTitle(it.title),
            contentMd: `> ${meta}\n\n${bodyText.slice(0, 480_000)}`,
            orderNo: this.orderNoOf(it.title),
            versionNo: 1,
            securityLevel: it.level,
            sourceItemId: it.id,
            createdBy: user.userId,
            updatedBy: user.userId,
          }),
        );
        await this.versionRepo.save(
          this.versionRepo.create({
            pageId: page.id,
            versionNo: 1,
            title: page.title,
            contentMd: page.contentMd,
            editedBy: user.userId,
          }),
        );
        await this.wikiPages.indexPageForImport(page.id);
        importedIds.add(it.id);
        this.job.createdPages += 1;
      } catch (err) {
        this.job.failed += 1;
        this.job.lastError = `${it.title}: ${(err as Error).message}`;
        this.logger.warn(`导入「${it.title}」失败，继续下一条：${(err as Error).message}`);
      }
    }
  }

  /** 去掉「004_」这类序号前缀做页面标题，序号本身转 orderNo */
  private cleanTitle(title: string): string {
    const m = /^(\d{1,5})_(.+)$/.exec(title);
    return m ? m[2].slice(0, 200) : title.slice(0, 200);
  }

  private orderNoOf(title: string): number {
    const m = /^(\d{1,5})_/.exec(title);
    return m ? Number.parseInt(m[1], 10) : 0;
  }
}
