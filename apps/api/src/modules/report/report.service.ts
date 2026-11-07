import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import {
  RETENTION_LABELS,
  SECURITY_LEVEL_LABELS,
  SecurityLevel,
  type BorrowStatsReport,
  type IntakeReport,
  type IntakeReportRow,
  type PermissionSnapshot,
  type StockReport,
  type StockReportRow,
  BizException,
  ErrorCode,
} from '@tianji/shared';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { Category } from '../../infra/database/entities/category.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { BorrowService } from '../borrow/borrow.service';

/** 报表查询区间 */
export interface ReportRange {
  from?: string;
  to?: string;
  fondsId?: string;
  categoryId?: string;
}

/** 导出产物 */
export interface ExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** 汇总行（SQL 分组原始结果） */
interface GroupRow {
  key: string | null;
  volumes: string;
  items: string;
  files: string;
  bytes: string;
}

/**
 * 统计报表服务（F-07）。
 *
 * 报表口径（PRD F-07）：
 *   - 库存统计：按全宗 / 年度 / 门类 / 保管期限四个维度，统计卷数、件数、文件数、字节数；
 *   - 接收统计：按年月统计新增卷/件/文件数；
 *   - 借阅统计：见 BorrowService.stats（按月、按状态、Top10 热门档案）。
 *
 * 重要：所有统计均走 AccessFilterBuilder 行级过滤，保证「看不到的档案不计入统计」。
 */
@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  public constructor(
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Volume) private readonly volumeRepo: Repository<Volume>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(Category) private readonly categoryRepo: Repository<Category>,
    @InjectRepository(ElectronicFile) private readonly fileRepo: Repository<ElectronicFile>,
    private readonly accessBuilder: AccessFilterBuilder,
    private readonly borrowService: BorrowService,
  ) {}

  // ==========================================================================
  // 库存统计
  // ==========================================================================

  /** 库存统计（四维度） */
  public async stock(range: ReportRange, user: PermissionSnapshot): Promise<StockReport> {
    const { clause, params } = this.accessBuilder.buildSql(user, 'i', { startIndex: 1 });
    const extra = this.buildRangeSql('i', range, params.length + 1);

    const where = [clause, ...extra.clauses].filter(Boolean).join(' AND ');
    const allParams = [...params, ...extra.params];

    const byFonds = await this.groupBy('fonds', where, allParams);
    const byYear = await this.groupBy('year', where, allParams);
    const byCategory = await this.groupBy('category', where, allParams);
    const byRetention = await this.groupBy('retention', where, allParams);

    const totalItems = byFonds.reduce((s, r) => s + r.itemCount, 0);
    const totalVolumes = byFonds.reduce((s, r) => s + r.volumeCount, 0);
    const totalFiles = byFonds.reduce((s, r) => s + r.fileCount, 0);
    const totalBytes = byFonds.reduce((s, r) => s + r.totalBytes, 0);

    return {
      generatedAt: new Date().toISOString(),
      range: { from: range.from ?? null, to: range.to ?? null },
      totalItems,
      totalVolumes,
      totalFiles,
      totalBytes,
      byFonds,
      byYear,
      byCategory,
      byRetention,
    };
  }

  /** 单维度分组统计（范围条件已由调用方拼入 where） */
  private async groupBy(
    dim: 'fonds' | 'year' | 'category' | 'retention',
    where: string,
    params: unknown[],
  ): Promise<StockReportRow[]> {
    const columnMap: Record<typeof dim, string> = {
      fonds: 'i.fonds_id',
      year: 'i.year',
      category: 'i.category_id',
      retention: 'i.retention',
    };
    const col = columnMap[dim];

    const sql = `
      SELECT ${col}::text AS key,
             COUNT(DISTINCT i.volume_id)::text AS volumes,
             COUNT(i.id)::text AS items,
             COALESCE(SUM(f.cnt), 0)::text AS files,
             COALESCE(SUM(f.bytes), 0)::text AS bytes
        FROM archive_item i
        LEFT JOIN (
          SELECT item_id, COUNT(*)::int AS cnt, COALESCE(SUM(size), 0)::bigint AS bytes
            FROM electronic_file
           GROUP BY item_id
        ) f ON f.item_id = i.id
       WHERE ${where}
       GROUP BY ${col}
       ORDER BY items DESC
    `;

    const rows = await this.itemRepo.query(sql, params);
    const raw = (rows as GroupRow[]) ?? [];
    const totalItems = raw.reduce((s, r) => s + Number(r.items ?? 0), 0);
    const labels = await this.resolveLabels(dim, raw.map((r) => r.key));

    return raw.map((r) => {
      const itemCount = Number(r.items ?? 0);
      return {
        key: r.key ?? '-',
        label: labels.get(r.key ?? '') ?? r.key ?? '未分类',
        volumeCount: Number(r.volumes ?? 0),
        itemCount,
        fileCount: Number(r.files ?? 0),
        totalBytes: Number(r.bytes ?? 0),
        ratio: totalItems === 0 ? 0 : Math.round((itemCount / totalItems) * 10000) / 10000,
      };
    });
  }

  /** 维度标签解析（全宗名 / 门类名 / 保管期限中文） */
  private async resolveLabels(
    dim: 'fonds' | 'year' | 'category' | 'retention',
    keys: Array<string | null>,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (dim === 'retention') {
      for (const k of keys) {
        if (k) map.set(k, RETENTION_LABELS[k as keyof typeof RETENTION_LABELS] ?? k);
      }
      return map;
    }
    const ids = keys.filter((k): k is string => !!k && k !== '-');
    if (ids.length === 0) return map;

    if (dim === 'fonds') {
      const rows = await this.fondsRepo.find({ where: ids.map((id) => ({ id })), select: ['id', 'name'] });
      for (const r of rows) map.set(r.id, r.name);
    } else if (dim === 'category') {
      const rows = await this.categoryRepo.find({ where: ids.map((id) => ({ id })), select: ['id', 'name'] });
      for (const r of rows) map.set(r.id, r.name);
    }
    return map;
  }

  /** 区间/全宗/门类附加条件（参数序号续接） */
  private buildRangeSql(
    alias: string,
    range: ReportRange,
    startIndex: number,
  ): { clauses: string[]; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = startIndex;

    if (range.from) {
      clauses.push(`${alias}.created_at >= $${idx++}`);
      params.push(new Date(range.from));
    }
    if (range.to) {
      clauses.push(`${alias}.created_at <= $${idx++}`);
      params.push(new Date(range.to));
    }
    if (range.fondsId) {
      clauses.push(`${alias}.fonds_id = $${idx++}`);
      params.push(range.fondsId);
    }
    if (range.categoryId) {
      clauses.push(`${alias}.category_id = $${idx++}`);
      params.push(range.categoryId);
    }
    return { clauses, params };
  }

  // ==========================================================================
  // 接收（入库）统计
  // ==========================================================================

  /** 按年月统计新增入库量 */
  public async intake(range: ReportRange, user: PermissionSnapshot): Promise<IntakeReport> {
    const { clause, params } = this.accessBuilder.buildSql(user, 'i', { startIndex: 1 });
    const extra = this.buildRangeSql('i', range, params.length + 1);
    const where = [clause, ...extra.clauses].filter(Boolean).join(' AND ');
    const allParams = [...params, ...extra.params];

    const sql = `
      SELECT EXTRACT(YEAR FROM i.created_at)::int AS year,
             EXTRACT(MONTH FROM i.created_at)::int AS month,
             COUNT(DISTINCT i.volume_id)::int AS volume_count,
             COUNT(i.id)::int AS item_count,
             COALESCE(SUM(f.cnt), 0)::int AS file_count
        FROM archive_item i
        LEFT JOIN (
          SELECT item_id, COUNT(*)::int AS cnt FROM electronic_file GROUP BY item_id
        ) f ON f.item_id = i.id
       WHERE ${where}
       GROUP BY year, month
       ORDER BY year ASC, month ASC
    `;

    const rows = (await this.itemRepo.query(sql, allParams)) as Array<{
      year: number;
      month: number;
      volume_count: number;
      item_count: number;
      file_count: number;
    }>;

    const mapped: IntakeReportRow[] = (rows ?? []).map((r) => ({
      year: Number(r.year),
      month: Number(r.month),
      volumeCount: Number(r.volume_count),
      itemCount: Number(r.item_count),
      fileCount: Number(r.file_count),
    }));

    return {
      generatedAt: new Date().toISOString(),
      rows: mapped,
      totalItems: mapped.reduce((s, r) => s + r.itemCount, 0),
    };
  }

  /** 借阅统计（委托 BorrowService，保持单一实现） */
  public async borrowStats(
    from?: string,
    to?: string,
    _user?: PermissionSnapshot,
  ): Promise<BorrowStatsReport> {
    return this.borrowService.stats(from, to);
  }

  // ==========================================================================
  // 导出（Excel）
  // ==========================================================================

  /** 库存统计导出为 xlsx */
  public async exportStock(range: ReportRange, user: PermissionSnapshot): Promise<ExportResult> {
    const report = await this.stock(range, user);
    const wb = new ExcelJS.Workbook();
    wb.creator = '天玑档案管理系统';
    wb.created = new Date();

    const summary = wb.addWorksheet('总览');
    summary.columns = [
      { header: '指标', key: 'k', width: 26 },
      { header: '数值', key: 'v', width: 22 },
    ];
    summary.addRows([
      { k: '生成时间', v: report.generatedAt },
      { k: '统计区间', v: `${report.range.from ?? '不限'} ~ ${report.range.to ?? '不限'}` },
      { k: '总件数', v: report.totalItems },
      { k: '总卷数', v: report.totalVolumes },
      { k: '电子文件数', v: report.totalFiles },
      { k: '总容量（字节）', v: report.totalBytes },
      { k: '总容量（GB）', v: (report.totalBytes / 1024 / 1024 / 1024).toFixed(2) },
    ]);
    this.styleSheet(summary);

    this.appendStockSheet(wb, '按全宗', report.byFonds);
    this.appendStockSheet(wb, '按年度', report.byYear);
    this.appendStockSheet(wb, '按门类', report.byCategory);
    this.appendStockSheet(wb, '按保管期限', report.byRetention);

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `库存统计_${this.stamp()}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /** 接收统计导出为 xlsx */
  public async exportIntake(range: ReportRange, user: PermissionSnapshot): Promise<ExportResult> {
    const report = await this.intake(range, user);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('接收统计');
    ws.columns = [
      { header: '年度', key: 'year', width: 12 },
      { header: '月份', key: 'month', width: 12 },
      { header: '新增卷数', key: 'volumeCount', width: 14 },
      { header: '新增件数', key: 'itemCount', width: 14 },
      { header: '新增文件数', key: 'fileCount', width: 16 },
    ];
    for (const r of report.rows) ws.addRow(r);
    this.styleSheet(ws);

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `接收统计_${this.stamp()}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /** 借阅统计导出为 xlsx */
  public async exportBorrow(from: string | undefined, to: string | undefined): Promise<ExportResult> {
    const report = await this.borrowService.stats(from, to);
    const wb = new ExcelJS.Workbook();

    const summary = wb.addWorksheet('总览');
    summary.columns = [
      { header: '指标', key: 'k', width: 26 },
      { header: '数值', key: 'v', width: 22 },
    ];
    summary.addRows([
      { k: '生成时间', v: report.generatedAt },
      { k: '借阅单总数', v: report.totalOrders },
      { k: '已归还', v: report.totalReturned },
      { k: '逾期', v: report.totalOverdue },
    ]);
    this.styleSheet(summary);

    const byMonth = wb.addWorksheet('按月');
    byMonth.columns = [
      { header: '月份', key: 'label', width: 16 },
      { header: '申请单数', key: 'orderCount', width: 14 },
      { header: '已归还', key: 'returnedCount', width: 14 },
      { header: '逾期', key: 'overdueCount', width: 14 },
    ];
    for (const r of report.byMonth) byMonth.addRow(r);
    this.styleSheet(byMonth);

    const top = wb.addWorksheet('热门档案');
    top.columns = [
      { header: '档号', key: 'danghao', width: 30 },
      { header: '题名', key: 'title', width: 40 },
      { header: '借阅次数', key: 'count', width: 14 },
    ];
    for (const r of report.topItems) top.addRow(r);
    this.styleSheet(top);

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `借阅统计_${this.stamp()}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /** 追加库存维度工作表 */
  private appendStockSheet(wb: ExcelJS.Workbook, name: string, rows: StockReportRow[]): void {
    const ws = wb.addWorksheet(name);
    ws.columns = [
      { header: '分类', key: 'label', width: 30 },
      { header: '卷数', key: 'volumeCount', width: 12 },
      { header: '件数', key: 'itemCount', width: 12 },
      { header: '文件数', key: 'fileCount', width: 12 },
      { header: '容量（字节）', key: 'totalBytes', width: 18 },
      { header: '件数占比', key: 'ratio', width: 12 },
    ];
    for (const r of rows) {
      ws.addRow({ ...r, ratio: `${(r.ratio * 100).toFixed(2)}%` });
    }
    this.styleSheet(ws);
  }

  /** 表头样式统一 */
  private styleSheet(ws: ExcelJS.Worksheet): void {
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    header.alignment = { vertical: 'middle', horizontal: 'center' };
    header.height = 22;
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      row.alignment = { vertical: 'middle' };
      if (idx % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6FA' } };
      }
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /** 文件名时间戳 */
  private stamp(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  /** 库存预警：超大文件（>500MB）清单，供管理员核查 */
  public async largeFiles(limit = 20): Promise<
    Array<{ id: string; filename: string; size: number; itemId: string; mime: string | null }>
  > {
    const rows = await this.fileRepo
      .createQueryBuilder('f')
      .orderBy('f.size', 'DESC')
      .limit(Math.min(200, Math.max(1, limit)))
      .getMany();
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      size: Number(r.size),
      itemId: r.itemId,
      mime: r.mime,
    }));
  }

  /** 密级分布（合规核查：秘密级档案数量） */
  public async securityDistribution(
    user: PermissionSnapshot,
  ): Promise<Array<{ level: SecurityLevel; label: string; count: number }>> {
    const { clause, params } = this.accessBuilder.buildSql(user, 'i', { startIndex: 1 });
    const rows = (await this.itemRepo.query(
      `SELECT i.security_level AS level, COUNT(*)::int AS cnt FROM archive_item i WHERE ${clause} GROUP BY i.security_level`,
      params,
    )) as Array<{ level: SecurityLevel; cnt: number }>;
    if (!rows || rows.length === 0) {
      throw new BizException(ErrorCode.NOT_FOUND, '暂无数据');
    }
    return rows.map((r) => ({
      level: r.level,
      label: SECURITY_LEVEL_LABELS[r.level] ?? r.level,
      count: Number(r.cnt),
    }));
  }
}
