import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { PermissionSnapshot } from '@tianji/shared';
import type { ImportTemplateField } from '../../infra/database/entities/import-batch.entity';
import {
  DataInfoService,
  type ConfirmImportResult,
  type ImportBatchDetailDto,
  type ImportBatchDto,
} from './datainfo.service';

/** 建立批次请求体 */
export class CreateImportBatchBodyDto {
  @IsString()
  @IsNotEmpty({ message: '批次名称不能为空' })
  @MaxLength(200)
  public name!: string;
}

/** 上传文本请求体 */
export class UploadImportBodyDto {
  @IsString()
  public content!: string;

  /** 第二步模板配置：选中的列映射，缺省沿用批次已保存模板或默认顺序 */
  @IsOptional()
  @IsArray()
  public templateJson?: ImportTemplateField[];
}

/**
 * 数据导入接口 P5（IMPORT_EXPORT 域）。
 * 五步向导：建立批次 → 模板配置 → 数据导入 → 确认 → 记录明细。
 */
@Controller('datainfo/import')
export class DataInfoController {
  constructor(private readonly service: DataInfoService) {}

  /** 批次列表 */
  @Get('batches')
  @RequirePerm({ domain: 'IMPORT_EXPORT', op: 'READ', checkScope: false, objectType: 'IMPORT_BATCH' })
  public async listBatches(): Promise<ImportBatchDto[]> {
    return this.service.listBatches();
  }

  /** 建立批次 */
  @Post('batches')
  @RequirePerm({ domain: 'IMPORT_EXPORT', op: 'WRITE', checkScope: false, objectType: 'IMPORT_BATCH' })
  @Audit({ action: 'CREATE', objectType: 'IMPORT_BATCH' })
  public async createBatch(
    @Body() dto: CreateImportBatchBodyDto,
    @CurrentUser('userId') userId: string,
  ): Promise<ImportBatchDto> {
    return this.service.createBatch(dto, userId ?? null);
  }

  /** 数据导入：接收 CSV / JSON 文本行 */
  @Post('batches/:id/upload')
  @RequirePerm({ domain: 'IMPORT_EXPORT', op: 'WRITE', checkScope: false, objectType: 'IMPORT_BATCH' })
  @Audit({ action: 'IMPORT', objectType: 'IMPORT_BATCH', objectIdPath: 'params.id' })
  public async upload(
    @Param('id') id: string,
    @Body() dto: UploadImportBodyDto,
    @CurrentUser() user: PermissionSnapshot,
  ): Promise<ImportBatchDetailDto> {
    return this.service.upload(id, dto, user?.userId ?? null);
  }

  /** 确认入库：明细批量写入 archive_item */
  @Post('batches/:id/confirm')
  @RequirePerm({ domain: 'IMPORT_EXPORT', op: 'WRITE', checkScope: false, objectType: 'IMPORT_BATCH' })
  @Audit({ action: 'APPROVE', objectType: 'IMPORT_BATCH', objectIdPath: 'params.id' })
  public async confirm(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<ConfirmImportResult> {
    return this.service.confirm(id, userId ?? null);
  }

  /** 记录明细 */
  @Get('batches/:id/detail')
  @RequirePerm({ domain: 'IMPORT_EXPORT', op: 'READ', checkScope: false, objectType: 'IMPORT_BATCH' })
  public async detail(@Param('id') id: string): Promise<ImportBatchDetailDto> {
    return this.service.detail(id);
  }
}
