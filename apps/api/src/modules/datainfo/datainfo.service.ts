import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  FondsStatus,
  Retention,
  SecurityLevel,
} from '@tianji/shared';
import {
  ImportBatch,
  type ImportBatchStatus,
  type ImportDetailRow,
  type ImportTemplateField,
} from '../../infra/database/entities/import-batch.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';

/** 批次列表项 */
export interface ImportBatchDto {
  id: string;
  batchNo: string;
  name: string;
  status: ImportBatchStatus;
  templateJson: ImportTemplateField[];
  createdBy: string | null;
  createdAt: string;
  confirmedAt: string | null;
  fileCount: number;
  successCount: number;
  failCount: number;
}

/** 批次明细查询结果 */
export interface ImportBatchDetailDto extends ImportBatchDto {
  details: ImportDetailRow[];
}

/** 建立批次请求 */
export interface CreateImportBatchInput {
  name: string;
}

/** 上传解析请求 */
export interface UploadImportInput {
  content: string;
  templateJson?: ImportTemplateField[];
}

/** 确认结果 */
export interface ConfirmImportResult {
  batch: ImportBatchDetailDto;
  inserted: number;
  skipped: number;
  invalid: number;
}

/** 默认列顺序（档号,题名,责任者,年度,密级） */
export const DEFAULT_IMPORT_TEMPLATE: ImportTemplateField[] = [
  { key: 'danghao', label: '档号', enabled: true },
  { key: 'title', label: '题名', enabled: true },
  { key: 'responsible', label: '责任者', enabled: true },
  { key: 'year', label: '年度', enabled: true },
  { key: 'securityLevel', label: '密级', enabled: true },
];

const SECURITY_LEVELS: readonly string[] = ['PUBLIC', 'INTERNAL', 'SECRET'];

/**
 * 数据导入服务 P5。
 *
 * 流程：建立批次 → 模板配置（列映射）→ 上传解析 → 确认入库 → 明细追溯。
 * 档号必填；确认时按档号去重、跳过已存在条目（数据库唯一约束 + orIgnore 兜底）。
 */
@Injectable()
export class DataInfoService {
  private readonly logger = new Logger(DataInfoService.name);

  constructor(
    @InjectRepository(ImportBatch) private readonly batchRepo: Repository<ImportBatch>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
  ) {}

  // ------------------------------------------------------------------ 批次

  /** 批次列表（倒序） */
  public async listBatches(): Promise<ImportBatchDto[]> {
    const rows = await this.batchRepo.find({ order: { createdAt: 'DESC' } });
    return rows.map((r) => this.toBatchDto(r));
  }

  /** 建立批次 */
  public async createBatch(
    input: CreateImportBatchInput,
    userId: string | null = null,
  ): Promise<ImportBatchDto> {
    const name = (input.name ?? '').trim();
    if (!name) throw new BizException(ErrorCode.BAD_REQUEST, '批次名称不能为空');
    const row = this.batchRepo.create({
      batchNo: this.nextBatchNo('IMP'),
      name,
      status: 'CREATED',
      templateJson: DEFAULT_IMPORT_TEMPLATE,
      createdBy: userId,
      confirmedAt: null,
      fileCount: 0,
      successCount: 0,
      failCount: 0,
      detailJson: [],
    });
    const saved = await this.batchRepo.save(row);
    return this.toBatchDto(saved);
  }

  /** 上传文本（CSV / JSON）并解析写入 detailJson */
  public async upload(
    id: string,
    input: UploadImportInput,
    userId: string | null = null,
  ): Promise<ImportBatchDetailDto> {
    const batch = await this.mustBatch(id);
    if (batch.status === 'CONFIRMED') {
      throw new BizException(ErrorCode.BAD_REQUEST, '批次已确认，不能再次导入');
    }
    const template =
      input.templateJson && input.templateJson.length > 0
        ? input.templateJson
        : batch.templateJson && batch.templateJson.length > 0
          ? batch.templateJson
          : DEFAULT_IMPORT_TEMPLATE;
    const details = this.parseContent(input.content, template);
    const successCount = details.filter((d) => d.valid).length;
    await this.batchRepo.update(
      { id },
      {
        status: 'UPLOADED',
        templateJson: template,
        detailJson: details,
        fileCount: details.length,
        successCount,
        failCount: details.length - successCount,
      },
    );
    this.logger.log(`导入批次 ${batch.batchNo} 解析 ${details.length} 行（成功 ${successCount}），操作人 ${userId ?? 'system'}`);
    return this.detail(id);
  }

  /** 确认：把有效明细批量写入 archive_item，跳过已存在档号 */
  public async confirm(id: string, userId: string | null = null): Promise<ConfirmImportResult> {
    const batch = await this.mustBatch(id);
    if (batch.status !== 'UPLOADED') {
      throw new BizException(ErrorCode.BAD_REQUEST, '请先上传数据（批次状态需为 UPLOADED）再确认');
    }
    const details: ImportDetailRow[] = batch.detailJson ?? [];
    const validRows = details.filter((d) => d.valid && d.danghao);
    if (validRows.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '没有可入库的有效明细（档号必填）');
    }

    // 批内按档号去重，保留首行
    const uniqueRows = Array.from(new Map(validRows.map((d) => [d.danghao, d])).values());
    const danghaoList = uniqueRows.map((d) => d.danghao);

    // 已存在档号（含已软删的，唯一索引覆盖全表）整批跳过
    const existing = await this.itemRepo.find({
      where: { danghao: In(danghaoList) },
      select: { danghao: true },
    });
    const existingSet = new Set(existing.map((r) => r.danghao));
    const toInsert = uniqueRows.filter((d) => !existingSet.has(d.danghao));

    // archive_item.fonds_id 为非空外键：取首个启用全宗作为导入落点
    const fonds = await this.fondsRepo.findOne({
      where: { status: FondsStatus.ACTIVE },
      order: { createdAt: 'ASC' },
    });
    if (!fonds) {
      throw new BizException(ErrorCode.BAD_REQUEST, '导入入库需要至少一个启用状态的全宗，请先建立全宗');
    }

    if (toInsert.length > 0) {
      await this.itemRepo
        .createQueryBuilder()
        .insert()
        .into(ArchiveItem)
        .values(
          toInsert.map((d) => ({
            fondsId: fonds.id,
            danghao: d.danghao,
            title: d.title || d.danghao,
            responsible: d.responsible,
            year: d.year ?? new Date().getFullYear(),
            retention: Retention.Y30,
            securityLevel: d.securityLevel,
            status: 'DRAFT' as const,
            keywords: [],
            extra: {},
            deleted: false,
            createdBy: userId,
          })),
        )
        .orIgnore()
        .execute();
    }

    const insertedSet = new Set(toInsert.map((d) => d.danghao));
    const finalDetails = details.map((d) => {
      const imported = d.valid && insertedSet.has(d.danghao);
      let error = d.error;
      if (!error && d.valid && !imported) error = '档号已存在，已跳过';
      return { ...d, imported, error };
    });
    const inserted = finalDetails.filter((d) => d.imported).length;
    const skipped = finalDetails.filter((d) => d.error === '档号已存在，已跳过').length;
    const invalid = finalDetails.filter((d) => !d.valid).length;

    await this.batchRepo.update(
      { id },
      {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        detailJson: finalDetails,
        successCount: inserted,
        failCount: finalDetails.length - inserted,
      },
    );
    this.logger.log(`导入批次 ${batch.batchNo} 确认入库 ${inserted} 条（跳过 ${skipped}，无效 ${invalid}）`);
    return { batch: await this.detail(id), inserted, skipped, invalid };
  }

  /** 批次明细 */
  public async detail(id: string): Promise<ImportBatchDetailDto> {
    const batch = await this.mustBatch(id);
    return { ...this.toBatchDto(batch), details: batch.detailJson ?? [] };
  }

  // ------------------------------------------------------------------ 内部

  private async mustBatch(id: string): Promise<ImportBatch> {
    const batch = await this.batchRepo.findOne({ where: { id } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '导入批次不存在');
    return batch;
  }

  private toBatchDto(r: ImportBatch): ImportBatchDto {
    return {
      id: r.id,
      batchNo: r.batchNo,
      name: r.name,
      status: r.status,
      templateJson: r.templateJson ?? [],
      createdBy: r.createdBy,
      createdAt: new Date(r.createdAt).toISOString(),
      confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
      fileCount: r.fileCount,
      successCount: r.successCount,
      failCount: r.failCount,
    };
  }

  private nextBatchNo(prefix: string): string {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
    return `${prefix}${ymd}-${rand}`;
  }

  /** 解析 CSV 文本行或 JSON 数组，按模板列映射生成明细 */
  private parseContent(content: string, template: ImportTemplateField[]): ImportDetailRow[] {
    const text = (content ?? '').trim();
    if (!text) return [];
    const enabled = template.filter((f) => f.enabled);
    const keys = (enabled.length > 0 ? enabled : DEFAULT_IMPORT_TEMPLATE).map((f) => f.key);

    // JSON 数组：按对象键名取值
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed.map((row, i) =>
            this.buildRow(i + 1, (row ?? {}) as Record<string, unknown>),
          );
        }
      } catch {
        // 非合法 JSON，按 CSV 继续解析
      }
    }

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return [];
    // 表头行（含「档号」或 danghao）跳过
    if (/档号|danghao/i.test(lines[0])) lines.shift();

    return lines.map((line, i) => {
      const cells = this.splitCsvLine(line);
      const values: Record<string, string> = {};
      keys.forEach((key, idx) => {
        values[key] = cells[idx] ?? '';
      });
      return this.buildRow(i + 1, values);
    });
  }

  private splitCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (ch === ',' && !quoted) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  private buildRow(line: number, raw: Record<string, unknown>): ImportDetailRow {
    const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) values[k] = str(v);

    const danghao = str(raw.danghao);
    const title = str(raw.title);
    const responsible = str(raw.responsible);
    const yearRaw = str(raw.year);
    const levelRaw = str(raw.securityLevel).toUpperCase();
    const securityLevel = (
      SECURITY_LEVELS.includes(levelRaw) ? levelRaw : 'PUBLIC'
    ) as SecurityLevel;
    const error = danghao.length === 0 ? '档号必填' : null;

    return {
      line,
      values,
      danghao,
      title,
      responsible: responsible.length > 0 ? responsible : null,
      year: /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
      securityLevel,
      valid: error === null,
      error,
      imported: false,
    };
  }
}
