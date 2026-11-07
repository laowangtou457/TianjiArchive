import { Controller, Get, Query, Res } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import type { Response } from 'express';
import type {
  BorrowStatsReport,
  IntakeReport,
  PermissionSnapshot,
  StockReport,
} from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ReportService } from './report.service';

/** 报表查询参数 */
export class ReportQueryDto {
  @IsOptional() @IsString() public from?: string;
  @IsOptional() @IsString() public to?: string;
  @IsOptional() @IsUUID() public fondsId?: string;
  @IsOptional() @IsUUID() public categoryId?: string;
}

/**
 * 统计报表控制器（F-07）。
 *
 * 导出接口强制留痕（EXPORT 属 MANDATORY_AUDIT_ACTIONS）。
 */
@Controller('reports')
export class ReportController {
  public constructor(private readonly reportService: ReportService) {}

  /** 库存统计 */
  @Get('stock')
  @RequirePerm({ domain: 'REPORT', op: 'READ', checkScope: false, objectType: 'REPORT' })
  public async stock(
    @Query() q: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StockReport> {
    return this.reportService.stock(
      { from: q.from, to: q.to, fondsId: q.fondsId, categoryId: q.categoryId },
      user as PermissionSnapshot,
    );
  }

  /** 接收（入库）统计 */
  @Get('intake')
  @RequirePerm({ domain: 'REPORT', op: 'READ', checkScope: false, objectType: 'REPORT' })
  public async intake(
    @Query() q: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<IntakeReport> {
    return this.reportService.intake(
      { from: q.from, to: q.to, fondsId: q.fondsId, categoryId: q.categoryId },
      user as PermissionSnapshot,
    );
  }

  /** 借阅统计 */
  @Get('borrow')
  @RequirePerm({ domain: 'REPORT', op: 'READ', checkScope: false, objectType: 'REPORT' })
  public async borrow(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<BorrowStatsReport> {
    return this.reportService.borrowStats(from, to);
  }

  /** 库存统计导出（Excel） */
  @Get('stock/export')
  @RequirePerm({ domain: 'REPORT', op: 'EXPORT', checkScope: false, objectType: 'REPORT' })
  @Audit({ action: 'EXPORT', objectType: 'REPORT', mandatory: true, objectIdPath: 'query.fondsId' })
  public async exportStock(
    @Query() q: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Buffer> {
    const file = await this.reportService.exportStock(
      { from: q.from, to: q.to, fondsId: q.fondsId, categoryId: q.categoryId },
      user as PermissionSnapshot,
    );
    this.setDownloadHeaders(res, file.filename, file.contentType);
    return file.buffer;
  }

  /** 接收统计导出（Excel） */
  @Get('intake/export')
  @RequirePerm({ domain: 'REPORT', op: 'EXPORT', checkScope: false, objectType: 'REPORT' })
  @Audit({ action: 'EXPORT', objectType: 'REPORT', mandatory: true, objectIdPath: 'query.fondsId' })
  public async exportIntake(
    @Query() q: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Buffer> {
    const file = await this.reportService.exportIntake(
      { from: q.from, to: q.to, fondsId: q.fondsId, categoryId: q.categoryId },
      user as PermissionSnapshot,
    );
    this.setDownloadHeaders(res, file.filename, file.contentType);
    return file.buffer;
  }

  /** 借阅统计导出（Excel） */
  @Get('borrow/export')
  @RequirePerm({ domain: 'REPORT', op: 'EXPORT', checkScope: false, objectType: 'REPORT' })
  @Audit({ action: 'EXPORT', objectType: 'REPORT', mandatory: true, objectIdPath: 'query.from' })
  public async exportBorrow(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Buffer> {
    const file = await this.reportService.exportBorrow(from, to);
    this.setDownloadHeaders(res, file.filename, file.contentType);
    return file.buffer;
  }

  /** 设置下载响应头（RFC 5987 中文文件名） */
  private setDownloadHeaders(res: Response, filename: string, contentType: string): void {
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  }
}
