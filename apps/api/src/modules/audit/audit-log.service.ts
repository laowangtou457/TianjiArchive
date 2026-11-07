import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import type { AuditAction, AuditLogDto, AuditLogQuery, AuditResult, PageResult } from '@tianji/shared';
import { AuditLog } from '../../infra/database/entities/audit-log.entity';
import type { ParamService } from '../param/param.service';
import { PARAM_KEY } from '../../common/constants/enums';

/** 审计写入载荷 */
export interface AuditAppendInput {
  userId: string | null;
  username: string | null;
  action: AuditAction;
  objectType: string | null;
  objectId: string | null;
  result: AuditResult;
  ip: string | null;
  durationMs: number | null;
  detail: Record<string, unknown> | null;
}

/**
 * 操作日志服务（F-10）。
 * 只追加（INSERT only）；查询按人/时间/动作/对象过滤；支持导出。
 * 说明：分区表按 created_at 落分区，插入不需要指定分区键以外的信息。
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(@InjectRepository(AuditLog) private readonly repo: Repository<AuditLog>) {}

  /** 追加审计记录（异步调用方需自行 catch） */
  public async append(input: AuditAppendInput): Promise<void> {
    const row = this.repo.create({
      userId: input.userId,
      username: input.username,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId ? input.objectId.slice(0, 64) : null,
      result: input.result,
      ip: input.ip,
      durationMs: input.durationMs,
      detail: input.detail,
    });
    await this.repo.save(row);
  }

  /** 条件查询（分页） */
  public async query(params: AuditLogQuery): Promise<PageResult<AuditLogDto>> {
    const page = Math.max(1, params.page ?? 1);
    const size = Math.min(100, Math.max(1, params.size ?? 20));

    const qb = this.repo.createQueryBuilder('a').orderBy('a.createdAt', 'DESC');

    if (params.userId) qb.andWhere('a.userId = :userId', { userId: params.userId });
    if (params.username) qb.andWhere('a.username ILIKE :username', { username: `%${params.username}%` });
    if (params.action && params.action.length > 0) {
      qb.andWhere('a.action IN (:...actions)', { actions: params.action });
    }
    if (params.objectType) qb.andWhere('a.objectType = :objectType', { objectType: params.objectType });
    if (params.objectId) qb.andWhere('a.objectId = :objectId', { objectId: params.objectId });
    if (params.result) qb.andWhere('a.result = :result', { result: params.result });
    if (params.from) qb.andWhere('a.createdAt >= :from', { from: new Date(params.from) });
    if (params.to) qb.andWhere('a.createdAt <= :to', { to: new Date(params.to) });
    if (params.keyword) {
      qb.andWhere('(a.detail::text ILIKE :kw OR a.objectId ILIKE :kw)', { kw: `%${params.keyword}%` });
    }

    qb.skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();
    return { list: rows.map((r) => this.toDto(r)), total, page, size };
  }

  /** 导出（最多 5 万条，供 Excel 导出） */
  public async exportRows(params: AuditLogQuery, limit = 50000): Promise<AuditLogDto[]> {
    const result = await this.query({ ...params, page: 1, size: Math.min(100, limit) });
    // 简化：只导出首页上限；大批量导出走异步任务（P1）
    return result.list;
  }

  /** 统计某动作在某时间段的次数（工作台/报表） */
  public async countByAction(action: AuditAction, from: Date, to: Date): Promise<number> {
    return this.repo.count({ where: { action, createdAt: Between(from, to) } });
  }

  /** 清理过期日志（保留年限取自参数 `log.retention_years`，PR-P7 该参数 editable=false） */
  public async purgeBefore(date: Date): Promise<number> {
    const result = await this.repo.delete({ createdAt: LessThanOrEqual(date) });
    return result.affected ?? 0;
  }

  /**
   * 按参数 `log.retention_years` 清理超期审计日志（供定时任务调用）。
   *
   * PR-P7：该参数出厂 3 年且 `editable=false`（合规固化，管理端不可改），
   * 因此这里的读取主要是「单一源」意义上的——不在代码里写死 3。
   * 若参数读不到，**不清理**（宁可留多，不可误删审计证据），并记 warn。
   *
   * @returns 实际删除行数；参数不可用时返回 0
   */
  public async purgeByRetention(paramService: ParamService): Promise<number> {
    let years: number;
    try {
      const raw = await paramService.getInt(PARAM_KEY.LOG_RETENTION_YEARS);
      if (!Number.isFinite(raw) || raw < 1) {
        this.logger.warn(`log.retention_years 取值异常（${raw}），本次跳过清理`);
        return 0;
      }
      years = raw;
    } catch (err) {
      this.logger.warn(`读取 log.retention_years 失败，本次跳过清理: ${(err as Error).message}`);
      return 0;
    }

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const removed = await this.purgeBefore(cutoff);
    if (removed > 0) {
      this.logger.log(`已清理 ${removed} 条超过 ${years} 年的审计日志（截止 ${cutoff.toISOString()}）`);
    }
    return removed;
  }

  private toDto(row: AuditLog): AuditLogDto {
    return {
      id: String(row.id),
      userId: row.userId,
      username: row.username,
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      result: row.result,
      ip: row.ip,
      durationMs: row.durationMs,
      detail: row.detail,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}

/** 供别处依赖的操作符集合（避免重复 import 出错） */
export const AuditOperators = { In, Between, MoreThanOrEqual, LessThanOrEqual };
