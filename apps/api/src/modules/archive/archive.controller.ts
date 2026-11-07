import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Delete,
} from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ItemStatus,
  OpenFlag,
  Retention,
  SecurityLevel,
  VolumeStatus,
  type BatchUpdateResult,
  type CreateItemDto,
  type CreateVolumeDto,
  type ItemDto,
  type PageResult,
  type VoidReassignResult,
  type VolumeDto,
} from '@tianji/shared';
import { ArchiveService } from './archive.service';
import { CurrentUser, RequirePerm, Audit } from '../../common/decorators/require-perm.decorator';

class CreateVolumeBodyDto implements CreateVolumeDto {
  @IsUUID()
  public fondsId!: string;

  @IsOptional()
  @IsUUID()
  public categoryId?: string | null;

  @IsOptional()
  @IsUUID()
  public orgId?: string | null;

  @IsString()
  @IsNotEmpty({ message: '案卷题名不能为空' })
  @MaxLength(500)
  public title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public responsible?: string | null;

  @IsInt()
  @Min(1900)
  public year!: number;

  @IsEnum(Retention)
  public retention!: Retention;

  @IsOptional()
  @IsEnum(SecurityLevel)
  public securityLevel?: SecurityLevel;

  @IsOptional()
  @IsDateString()
  public startDate?: string | null;

  @IsOptional()
  @IsDateString()
  public endDate?: string | null;

  @IsOptional()
  @IsString()
  public classNo?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public keywords?: string[];

  @IsOptional()
  @IsString()
  public note?: string | null;

  @IsOptional()
  @IsString()
  public catalogNo?: string | null;

  @IsOptional()
  public extra?: Record<string, unknown>;
}

class CreateItemBodyDto implements CreateItemDto {
  @IsString()
  @IsNotEmpty({ message: '文件题名不能为空' })
  @MaxLength(500)
  public title!: string;

  @IsString()
  @IsNotEmpty({ message: '责任者不能为空' })
  @MaxLength(200)
  public responsible!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public docNo?: string | null;

  @IsDateString({}, { message: '形成日期格式应为 YYYY-MM-DD' })
  public docDate!: string;

  @IsOptional()
  @IsInt()
  public year?: number;

  @IsOptional()
  @IsEnum(Retention)
  public retention?: Retention;

  @IsOptional()
  @IsEnum(SecurityLevel)
  public securityLevel?: SecurityLevel;

  @IsOptional()
  @IsString()
  public categoryCode?: string | null;

  @IsOptional()
  @IsString()
  public classNo?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public keywords?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  public pages?: number | null;

  @IsOptional()
  @IsString()
  public note?: string | null;

  @IsOptional()
  @IsEnum(OpenFlag)
  public openFlag?: OpenFlag;

  @IsOptional()
  public extra?: Record<string, unknown>;
}

class UpdateItemBodyDto extends CreateItemBodyDto {
  @IsOptional()
  @IsString()
  declare public title: string;

  @IsOptional()
  @IsString()
  declare public responsible: string;

  @IsOptional()
  @IsDateString()
  declare public docDate: string;

  @IsOptional()
  @IsString()
  public danghao?: string;

  @IsOptional()
  public updatedAt?: string;
}

class BatchUpdateBodyDto {
  @IsArray()
  @ArrayNotEmpty({ message: '请选择要修改的条目' })
  @IsUUID('all', { each: true })
  public ids!: string[];

  @ValidateNested()
  @Type(() => CreateItemBodyDto)
  public patch!: Partial<CreateItemBodyDto>;
}

class VoidReassignBodyDto {
  @IsString()
  @IsNotEmpty({ message: '作废原因不能为空' })
  @MaxLength(500)
  public reason!: string;

  @IsOptional()
  public reassign?: boolean;
}

/**
 * 著录接口（F-03 案卷 / F-04 件级）。
 * 档号由服务端分配；档号不可改，只能作废重编。
 */
@Controller('archive')
export class ArchiveController {
  constructor(private readonly service: ArchiveService) {}

  // ---------------------------------------------------------------- 案卷
  @Get('volumes')
  @RequirePerm({ domain: 'VOLUME', op: 'READ', checkScope: false, objectType: 'VOLUME' })
  public async listVolumes(
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('fondsId') fondsId?: string,
    @Query('year') year?: string,
    @Query('status') status?: VolumeStatus,
    @Query('categoryId') categoryId?: string,
    @Query('keyword') keyword?: string,
    @CurrentUser('fondsIds') fondsIds?: string[] | null,
  ): Promise<PageResult<VolumeDto>> {
    return this.service.listVolumes({
      page: Number.parseInt(page ?? '1', 10) || 1,
      size: Number.parseInt(size ?? '20', 10) || 20,
      fondsId,
      year: year ? Number.parseInt(year, 10) : undefined,
      status,
      categoryId,
      keyword,
      allowedFondsIds: fondsIds ?? null,
    });
  }

  @Get('volumes/:id')
  @RequirePerm({ domain: 'VOLUME', op: 'READ', checkScope: true, objectType: 'VOLUME' })
  public async volumeDetail(@Param('id') id: string): Promise<VolumeDto> {
    return this.service.volumeDetail(id);
  }

  @Post('volumes')
  @RequirePerm({ domain: 'VOLUME', op: 'WRITE', checkScope: true, objectType: 'VOLUME' })
  public async createVolume(
    @Body() dto: CreateVolumeBodyDto,
    @CurrentUser('userId') userId: string,
  ): Promise<VolumeDto> {
    return this.service.createVolume(dto, userId);
  }

  @Patch('volumes/:id')
  @RequirePerm({ domain: 'VOLUME', op: 'WRITE', checkScope: true, objectType: 'VOLUME' })
  public async updateVolume(
    @Param('id') id: string,
    @Body() dto: Partial<CreateVolumeBodyDto> & { danghao?: string },
  ): Promise<VolumeDto> {
    return this.service.updateVolume(id, dto);
  }

  /** 归档确认（R1 权限：ARCHIVE_CONFIRM） */
  @Post('volumes/:id/confirm')
  @RequirePerm({ domain: 'ARCHIVE_CONFIRM', op: 'APPROVE', checkScope: true, objectType: 'VOLUME' })
  public async confirmVolume(@Param('id') id: string): Promise<VolumeDto> {
    return this.service.confirmVolume(id);
  }

  @Delete('volumes/:id')
  @RequirePerm({ domain: 'VOLUME', op: 'DELETE', checkScope: true, objectType: 'VOLUME' })
  public async deleteVolume(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<{ deleted: boolean }> {
    const r = await this.service.softDeleteVolume(id, userId ?? null);
    return { deleted: r.deleted };
  }

  // ---------------------------------------------------------------- 件
  @Get('volumes/:id/items')
  @RequirePerm({ domain: 'ITEM', op: 'READ', checkScope: false, objectType: 'ITEM' })
  public async listVolumeItems(
    @Param('id') volumeId: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('keyword') keyword?: string,
  ): Promise<PageResult<ItemDto>> {
    return this.service.listItems({
      page: Number.parseInt(page ?? '1', 10) || 1,
      size: Number.parseInt(size ?? '100', 10) || 100,
      volumeId,
      keyword,
    });
  }

  @Get('items')
  @RequirePerm({ domain: 'ITEM', op: 'READ', checkScope: false, objectType: 'ITEM' })
  public async listItems(
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('fondsId') fondsId?: string,
    @Query('year') year?: string,
    @Query('status') status?: ItemStatus,
    @Query('keyword') keyword?: string,
    @CurrentUser('fondsIds') fondsIds?: string[] | null,
  ): Promise<PageResult<ItemDto>> {
    return this.service.listItems({
      page: Number.parseInt(page ?? '1', 10) || 1,
      size: Number.parseInt(size ?? '20', 10) || 20,
      fondsId,
      year: year ? Number.parseInt(year, 10) : undefined,
      status,
      keyword,
      allowedFondsIds: fondsIds ?? null,
    });
  }

  @Get('items/:id')
  @RequirePerm({ domain: 'ITEM', op: 'READ', checkScope: true, objectType: 'ITEM' })
  public async itemDetail(@Param('id') id: string): Promise<ItemDto> {
    return this.service.itemDetail(id);
  }

  /** 卷内新增件（继承卷级字段 + 服务端分配档号） */
  @Post('volumes/:id/items')
  @RequirePerm({ domain: 'ITEM', op: 'WRITE', checkScope: true, objectType: 'ITEM' })
  public async createItemInVolume(
    @Param('id') volumeId: string,
    @Body() dto: CreateItemBodyDto,
    @CurrentUser('userId') userId: string,
  ): Promise<ItemDto> {
    return this.service.createItemInVolume(volumeId, dto, userId);
  }

  /** 独立新增件 */
  @Post('items')
  @RequirePerm({ domain: 'ITEM', op: 'WRITE', checkScope: true, objectType: 'ITEM' })
  public async createItem(
    @Body() dto: CreateItemBodyDto & { fondsId: string; categoryId?: string; orgId?: string },
    @CurrentUser('userId') userId: string,
  ): Promise<ItemDto> {
    return this.service.createItem(dto, userId);
  }

  @Patch('items/:id')
  @RequirePerm({ domain: 'ITEM', op: 'WRITE', checkScope: true, objectType: 'ITEM' })
  public async updateItem(
    @Param('id') id: string,
    @Body() dto: UpdateItemBodyDto,
  ): Promise<ItemDto> {
    return this.service.updateItem({ ...dto, id });
  }

  /** 提交归档 */
  @Post('items/:id/submit')
  @RequirePerm({ domain: 'ITEM', op: 'WRITE', checkScope: true, objectType: 'ITEM' })
  public async submitItem(@Param('id') id: string): Promise<ItemDto> {
    return this.service.submitItem(id);
  }

  /** 归档确认（批量） */
  @Post('items/confirm')
  @RequirePerm({
    domain: 'ARCHIVE_CONFIRM',
    op: 'APPROVE',
    checkScope: false,
    objectType: 'ITEM',
  })
  public async confirmItems(@Body() dto: { ids: string[] }): Promise<{ confirmed: number }> {
    return this.service.confirmItems(dto.ids ?? []);
  }

  /** 批量修改（≥500 条） */
  @Post('items/batch-update')
  @RequirePerm({ domain: 'ITEM', op: 'WRITE', checkScope: false, objectType: 'ITEM' })
  @Audit({ action: 'UPDATE', objectType: 'ITEM' })
  public async batchUpdate(@Body() dto: BatchUpdateBodyDto): Promise<BatchUpdateResult> {
    return this.service.batchUpdate(dto);
  }

  /**
   * 作废重编（档号唯一可变通道，强制留痕）。
   */
  @Post('items/:id/void')
  @RequirePerm({ domain: 'ITEM', op: 'WRITE', checkScope: true, objectType: 'ITEM' })
  @Audit({
    action: 'VOID',
    objectType: 'ITEM',
    mandatory: true,
    objectIdPath: 'params.id',
  })
  public async voidItem(
    @Param('id') id: string,
    @Body() dto: VoidReassignBodyDto,
    @CurrentUser('userId') userId: string,
  ): Promise<VoidReassignResult> {
    return this.service.voidAndReassign(id, dto, userId);
  }

  @Delete('items/:id')
  @RequirePerm({ domain: 'ITEM', op: 'DELETE', checkScope: true, objectType: 'ITEM' })
  public async deleteItem(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<{ deleted: boolean }> {
    const r = await this.service.softDeleteItem(id, userId ?? null);
    return { deleted: r.deleted };
  }
}
