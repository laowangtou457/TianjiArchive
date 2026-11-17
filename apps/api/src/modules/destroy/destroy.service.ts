import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BizException, ErrorCode } from '@tianji/shared';
import { ArchiveService } from '../archive/archive.service';
import {
  DestroyBatch,
  type DestroyBatchStatus,
} from '../../infra/database/entities/destroy-batch.entity';
import { DestroyEntry } from '../../infra/database/entities/destroy-entry.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { RecycleBin } from '../../infra/database/entities/recycle-bin.entity';

/** 销毁批次 DTO */
export interface DestroyBatchDto {
  id: string;
  batchNo: string;
  reason: string;
  status: DestroyBatchStatus;
  itemIds: string[];
  createdBy: string | null;
  createdAt: string;
}

/** 销毁明细 DTO */
export interface DestroyEntryDto {
  id: string;
  batchId: string;
  itemId: string | null;
  danghao: string;
  title: string | null;
  result: string;
  createdAt: string;
}

/** 建立批次入参：itemIds（UUID）与 danghaos（档号多行）可混用 */
export interface CreateDestroyBatchInput {
  reason: string;
  itemIds?: string[];
  danghaos?: string[];
}

/** 执行结果 */
export interface DestroyExecuteResult {
  batch: DestroyBatchDto;
  destroyed: number;
  failed: number;
}

/** 待销毁候选（供前端自动补全） */
export interface DestroyCandidateDto {
  id: string;
  danghao: string;
  title: string;
  year: number;
  retention: string;
  securityLevel: string;
  fondsId: string;
}

/** 还原结果 */
export interface DestroyRestoreResult {
  restored: number;
  failed: number;
  batch: DestroyBatchDto;
}

/**
 * 销毁批次服务 P5（RECYCLE 域）。
 * 建立 → 审核 → 执行；执行调用 ArchiveService.softDeleteItem 完成软删除 + 回收站留痕。
 */
@Injectable()
export class DestroyService {
  private readonly logger = new Logger(DestroyService.name);

  constructor(
    @InjectRepository(DestroyBatch)
    private readonly batchRepo: Repository<DestroyBatch>,
    @InjectRepository(DestroyEntry)
    private readonly entryRepo: Repository<DestroyEntry>,
    @InjectRepository(ArchiveItem)
    private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(RecycleBin)
    private readonly recycleRepo: Repository<RecycleBin>,
    private readonly archiveService: ArchiveService,
  ) {}

  /** 批次列表 */
  public async listBatches(): Promise<DestroyBatchDto[]> {
    const rows = await this.batchRepo.find({ order: { createdAt: 'DESC' } });
    return rows.map((r) => this.toBatchDto(r));
  }

  /** 建立批次：解析条目（按 id 或档号）并生成销毁明细 */
  public async createBatch(
    input: CreateDestroyBatchInput,
    userId: string | null = null,
  ): Promise<DestroyBatchDto> {
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new BizException(ErrorCode.BAD_REQUEST, '销毁原因不能为空');

    const ids = Array.isArray(input.itemIds) ? input.itemIds.map((s) => String(s).trim()).filter(Boolean) : [];
    const danghaos = Array.isArray(input.danghaos)
      ? input.danghaos.map((s) => String(s).trim()).filter(Boolean)
      : [];
    if (ids.length === 0 && danghaos.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '请至少指定一个待销毁条目（ID 或档号）');
    }

    const byId =
      ids.length > 0
        ? await this.itemRepo.find({ where: { id: In(ids), deleted: false } })
        : [];
    const byDanghao =
      danghaos.length > 0
        ? await this.itemRepo.find({ where: { danghao: In(danghaos), deleted: false } })
        : [];

    const matched = new Map<string, ArchiveItem>();
    for (const item of [...byId, ...byDanghao]) matched.set(item.id, item);
    if (matched.size === 0) {
      throw new BizException(ErrorCode.NOT_FOUND, '未匹配到任何待销毁档案条目');
    }

    const items = Array.from(matched.values());
    const savedBatch = await this.batchRepo.save(
      this.batchRepo.create({
        batchNo: this.nextBatchNo('DES'),
        reason,
        status: 'PENDING',
        itemIdsJson: items.map((i) => i.id),
        createdBy: userId,
      }),
    );

    const matchedDanghao = new Set(items.map((i) => i.danghao));
    const entries: DestroyEntry[] = items.map((item) =>
      this.entryRepo.create({
        batchId: savedBatch.id,
        itemId: item.id,
        danghao: item.danghao,
        title: item.title,
        result: 'PENDING',
      }),
    );
    // 粘贴的档号未匹配到条目的，也留痕便于核对
    for (const dh of danghaos) {
      if (!matchedDanghao.has(dh)) {
        entries.push(
          this.entryRepo.create({
            batchId: savedBatch.id,
            itemId: null,
            danghao: dh,
            title: null,
            result: 'NOT_FOUND',
          }),
        );
      }
    }
    if (entries.length > 0) await this.entryRepo.save(entries);
    return this.toBatchDto(savedBatch);
  }

  /** 审核通过：PENDING → APPROVED */
  public async approve(id: string): Promise<DestroyBatchDto> {
    const batch = await this.mustBatch(id);
    if (batch.status !== 'PENDING') {
      throw new BizException(ErrorCode.BAD_REQUEST, '仅待审核批次可以审核通过');
    }
    await this.batchRepo.update({ id }, { status: 'APPROVED' });
    return this.toBatchDto(await this.mustBatch(id));
  }

  /** 执行销毁：APPROVED → DESTROYED，逐条软删除并写留痕 */
  public async execute(id: string, userId: string | null = null): Promise<DestroyExecuteResult> {
    const batch = await this.mustBatch(id);
    if (batch.status !== 'APPROVED') {
      throw new BizException(ErrorCode.BAD_REQUEST, '仅已审核批次可以执行销毁');
    }
    const entries = await this.entryRepo.find({ where: { batchId: id } });
    let destroyed = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!entry.itemId || entry.result === 'NOT_FOUND') continue;
      try {
        await this.archiveService.softDeleteItem(entry.itemId, userId);
        await this.entryRepo.update({ id: entry.id }, { result: 'DESTROYED' });
        destroyed += 1;
      } catch (err: unknown) {
        failed += 1;
        await this.entryRepo.update({ id: entry.id }, { result: 'FAILED' });
        this.logger.warn(
          `销毁条目 ${entry.danghao} 执行失败：${(err as Error)?.message ?? String(err)}`,
        );
      }
    }
    await this.batchRepo.update({ id }, { status: 'DESTROYED' });
    return { batch: this.toBatchDto(await this.mustBatch(id)), destroyed, failed };
  }

  /** 批次明细/留痕 */
  public async entries(id: string): Promise<DestroyEntryDto[]> {
    await this.mustBatch(id);
    const rows = await this.entryRepo.find({ where: { batchId: id }, order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toEntryDto(r));
  }

  /**
   * 待销毁候选检索（供前端自动补全）。
   * 只返回未删除、已归档的条目——草稿/待审核件不该出现在销毁清单里。
   */
  public async candidates(
    keyword: string | undefined,
    allowedFondsIds: string[] | null,
    size = 20,
  ): Promise<DestroyCandidateDto[]> {
    const qb = this.itemRepo
      .createQueryBuilder('i')
      .where('i.deleted = FALSE')
      .andWhere(`i.status = 'ARCHIVED'`);
    if (keyword && keyword.trim()) {
      qb.andWhere('(i.danghao ILIKE :kw OR i.title ILIKE :kw OR i.responsible ILIKE :kw)', {
        kw: `%${keyword.trim()}%`,
      });
    }
    if (allowedFondsIds !== null) {
      if (allowedFondsIds.length === 0) return [];
      qb.andWhere('i.fondsId IN (:...fonds)', { fonds: allowedFondsIds });
    }
    const rows = await qb
      .orderBy('i.danghao', 'ASC')
      .take(Math.min(50, Math.max(1, size)))
      .getMany();
    return rows.map((r) => ({
      id: r.id,
      danghao: r.danghao,
      title: r.title,
      year: r.year,
      retention: r.retention,
      securityLevel: r.securityLevel,
      fondsId: r.fondsId,
    }));
  }

  /** 还原已销毁批次：把批次内条目从回收站恢复，并解除回收站记录 */
  public async restoreBatch(batchId: string): Promise<DestroyRestoreResult> {
    const batch = await this.mustBatch(batchId);
    if (batch.status !== 'DESTROYED') {
      throw new BizException(ErrorCode.CONFLICT, '只有「已销毁」的批次可以还原');
    }
    const entries = await this.entryRepo.find({ where: { batchId } });
    let restored = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!entry.itemId) {
        failed += 1;
        continue;
      }
      const item = await this.itemRepo.findOne({ where: { id: entry.itemId } });
      const rec = await this.recycleRepo.findOne({ where: { objectId: entry.itemId } });
      if (!item || !rec || rec.purgeAfter.getTime() <= Date.now()) {
        failed += 1;
        continue;
      }
      const conflict = await this.itemRepo.count({
        where: { danghao: entry.danghao, deleted: false },
      });
      if (conflict > 0) {
        failed += 1;
        continue;
      }
      await this.itemRepo.update({ id: entry.itemId }, { deleted: false });
      if (item.volumeId) {
        await this.itemRepo.manager.increment('volume', { id: item.volumeId }, 'item_count', 1);
      }
      await this.recycleRepo.delete({ id: rec.id });
      await this.entryRepo.update({ id: entry.id }, { result: 'RESTORED' });
      restored += 1;
    }
    await this.batchRepo.update({ id: batchId }, { status: 'RESTORED', updatedAt: new Date() });
    this.logger.log(`销毁批次 ${batch.batchNo} 还原：成功 ${restored}，失败 ${failed}`);
    return { restored, failed, batch: this.toBatchDto(await this.mustBatch(batchId)) };
  }

  private async mustBatch(id: string): Promise<DestroyBatch> {
    const batch = await this.batchRepo.findOne({ where: { id } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '销毁批次不存在');
    return batch;
  }

  private nextBatchNo(prefix: string): string {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
    return `${prefix}${ymd}-${rand}`;
  }

  private toBatchDto(r: DestroyBatch): DestroyBatchDto {
    return {
      id: r.id,
      batchNo: r.batchNo,
      reason: r.reason,
      status: r.status,
      itemIds: r.itemIdsJson ?? [],
      createdBy: r.createdBy,
      createdAt: new Date(r.createdAt).toISOString(),
    };
  }

  private toEntryDto(r: DestroyEntry): DestroyEntryDto {
    return {
      id: r.id,
      batchId: r.batchId,
      itemId: r.itemId,
      danghao: r.danghao,
      title: r.title,
      result: r.result,
      createdAt: new Date(r.createdAt).toISOString(),
    };
  }
}
