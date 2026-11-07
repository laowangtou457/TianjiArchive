import { Controller, Get, Query, Res } from '@nestjs/common';
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import {
  AUDIT_ACTION_LABELS,
  AuditAction,
  AuditResult,
  type AuditLogDto,
  type PageResult,
} from '@tianji/shared';
import { AuditLogService } from './audit-log.service';
import { RequirePerm } from '../../common/decorators/require-perm.decorator';

class AuditLogQueryDto {
  @IsOptional()
  public page?: number;

  @IsOptional()
  public size?: number;

  @IsOptional()
  @IsString()
  public userId?: string;

  @IsOptional()
  @IsString()
  public username?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(AuditAction, { each: true })
  public action?: AuditAction[];

  @IsOptional()
  @IsString()
  public objectType?: string;

  @IsOptional()
  @IsString()
  public objectId?: string;

  @IsOptional()
  @IsEnum(AuditResult)
  public result?: AuditResult;

  @IsOptional()
  @IsString()
  public from?: string;

  @IsOptional()
  @IsString()
  public to?: string;

  @IsOptional()
  @IsString()
  public keyword?: string;
}

/**
 * 操作日志接口（F-10）。R0 全量、R1 业务日志只读、R4 只读。
 */
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly service: AuditLogService) {}

  @Get()
  @RequirePerm({
    domain: 'AUDIT_LOG',
    op: 'READ',
    checkScope: false,
    objectType: 'AUDIT_LOG',
  })
  public async list(@Query() query: AuditLogQueryDto): Promise<PageResult<AuditLogDto>> {
    return this.service.query({
      ...query,
      page: query.page ? Number(query.page) : 1,
      size: query.size ? Number(query.size) : 20,
    });
  }

  /** 导出 CSV（Excel 可直接打开），日志为审计凭证，导出行为本身也留痕 */
  @Get('export')
  @RequirePerm({
    domain: 'AUDIT_LOG',
    op: 'EXPORT',
    checkScope: false,
    objectType: 'AUDIT_LOG',
  })
  public async export(
    @Query() query: AuditLogQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const rows = await this.service.exportRows({
      ...query,
      page: 1,
      size: 100,
    });
    const header = ['时间', '操作人', '动作', '对象类型', '对象ID', '结果', 'IP', '耗时(ms)'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.createdAt,
          r.username ?? '',
          AUDIT_ACTION_LABELS[r.action] ?? r.action,
          r.objectType ?? '',
          r.objectId ?? '',
          r.result,
          r.ip ?? '',
          r.durationMs ?? '',
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    return `\uFEFF${lines.join('\n')}`;
  }
}
