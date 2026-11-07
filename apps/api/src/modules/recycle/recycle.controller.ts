import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { RecycleObjectType, type PermissionSnapshot, type RecycleBinDto } from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { RecycleService } from './recycle.service';

/** 回收站查询参数 */
export class RecycleQueryDto {
  @IsOptional() @IsEnum(RecycleObjectType) public objectType?: RecycleObjectType;
  @IsOptional() @IsString() public keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
}

/**
 * 回收站控制器（F-18）。
 * 还原 RESTORE 与销毁 DELETE 均强制留痕。
 */
@Controller('recycle')
export class RecycleController {
  public constructor(private readonly recycleService: RecycleService) {}

  /** 回收站列表 */
  @Get()
  @RequirePerm({ domain: 'RECYCLE', op: 'READ', checkScope: false, objectType: 'RECYCLE_BIN' })
  public async list(
    @Query() q: RecycleQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: RecycleBinDto[]; total: number; page: number; size: number }> {
    return this.recycleService.list(
      { objectType: q.objectType, keyword: q.keyword, page: q.page, size: q.size },
      user as PermissionSnapshot,
    );
  }

  /** 还原 */
  @Post(':id/restore')
  @RequirePerm({ domain: 'RECYCLE', op: 'WRITE', checkScope: false, objectType: 'RECYCLE_BIN' })
  @Audit({ action: 'RESTORE', objectType: 'RECYCLE_BIN', mandatory: true, objectIdPath: 'params.id' })
  public async restore(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ restored: boolean }> {
    return this.recycleService.restore(id, user as PermissionSnapshot);
  }

  /** 彻底销毁 */
  @Delete(':id')
  @RequirePerm({ domain: 'RECYCLE', op: 'DELETE', checkScope: false, objectType: 'RECYCLE_BIN' })
  @Audit({ action: 'DELETE', objectType: 'RECYCLE_BIN', mandatory: true, objectIdPath: 'params.id' })
  public async purge(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ purged: boolean }> {
    return this.recycleService.purge(id, user as PermissionSnapshot);
  }
}
