import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import type { BackupRecordDto, PermissionSnapshot } from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { BackupService, type RestoreVerifyResult } from './backup.service';

/** 备份范围 */
export enum BackupScope {
  FULL = 'full',
  DB = 'db',
  MINIO = 'minio',
  META = 'meta',
}

/** 触发备份 DTO */
export class TriggerBackupDto {
  @IsOptional() @IsEnum(BackupScope) public scope?: BackupScope;
}

/** 列表查询 DTO */
export class BackupQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
  @IsOptional() @IsString() public status?: string;
}

/**
 * 备份控制器（F-11）。
 * 触发备份与恢复演练均强制留痕（BACKUP / RESTORE 属强制审计动作）。
 */
@Controller('backups')
export class BackupController {
  public constructor(private readonly backupService: BackupService) {}

  /** 触发备份（异步，返回 RUNNING 记录） */
  @Post('run')
  @RequirePerm({ domain: 'BACKUP', op: 'WRITE', checkScope: false, objectType: 'BACKUP_RECORD' })
  @Audit({ action: 'BACKUP', objectType: 'BACKUP_RECORD', mandatory: true, objectIdPath: 'body.scope' })
  public async run(
    @Body() dto: TriggerBackupDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BackupRecordDto> {
    const scope = dto.scope ?? BackupScope.FULL;
    if (scope === BackupScope.META) {
      return this.backupService.runLightweight(user as PermissionSnapshot);
    }
    return this.backupService.trigger(scope, user as PermissionSnapshot);
  }

  /** 备份记录列表 */
  @Get()
  @RequirePerm({ domain: 'BACKUP', op: 'READ', checkScope: false, objectType: 'BACKUP_RECORD' })
  public async list(
    @Query() q: BackupQueryDto,
  ): Promise<{ items: BackupRecordDto[]; total: number; page: number; size: number }> {
    return this.backupService.list({ page: q.page, size: q.size, status: q.status });
  }

  /** 备份成功率 */
  @Get('success-rate')
  @RequirePerm({ domain: 'BACKUP', op: 'READ', checkScope: false, objectType: 'BACKUP_RECORD' })
  public async successRate(
    @Query('last') last?: string,
  ): Promise<{ total: number; ok: number; failed: number; rate: number }> {
    return this.backupService.successRate(Number(last ?? 30) || 30);
  }

  /** 恢复演练（校验 + 指引 + 留痕） */
  @Post(':id/verify-restore')
  @RequirePerm({ domain: 'BACKUP', op: 'APPROVE', checkScope: false, objectType: 'BACKUP_RECORD' })
  @Audit({ action: 'RESTORE', objectType: 'BACKUP_RECORD', mandatory: true, objectIdPath: 'params.id' })
  public async verifyRestore(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RestoreVerifyResult> {
    return this.backupService.verifyRestore(id, user as PermissionSnapshot);
  }
}
