import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import {
  DestroyService,
  type DestroyBatchDto,
  type DestroyEntryDto,
  type DestroyExecuteResult,
} from './destroy.service';

/** 建立销毁批次请求体 */
export class CreateDestroyBatchBodyDto {
  @IsString()
  @IsNotEmpty({ message: '销毁原因不能为空' })
  @MaxLength(500)
  public reason!: string;

  /** 按条目 ID 指定 */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  public itemIds?: string[];

  /** 按档号指定（前端粘贴多行档号） */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  public danghaos?: string[];
}

/**
 * 销毁批次接口 P5（RECYCLE 域）。
 * 建立批次 → 审核 → 执行销毁 → 查询留痕。
 */
@Controller('destroy')
export class DestroyController {
  constructor(private readonly service: DestroyService) {}

  /** 批次列表 */
  @Get('batches')
  @RequirePerm({ domain: 'RECYCLE', op: 'READ', checkScope: false, objectType: 'DESTROY_BATCH' })
  public async listBatches(): Promise<DestroyBatchDto[]> {
    return this.service.listBatches();
  }

  /** 建立批次 */
  @Post('batches')
  @RequirePerm({ domain: 'RECYCLE', op: 'WRITE', checkScope: false, objectType: 'DESTROY_BATCH' })
  @Audit({ action: 'CREATE', objectType: 'DESTROY_BATCH' })
  public async create(
    @Body() dto: CreateDestroyBatchBodyDto,
    @CurrentUser('userId') userId: string,
  ): Promise<DestroyBatchDto> {
    return this.service.createBatch(dto, userId ?? null);
  }

  /** 审核通过 */
  @Post('batches/:id/approve')
  @RequirePerm({ domain: 'RECYCLE', op: 'WRITE', checkScope: false, objectType: 'DESTROY_BATCH' })
  @Audit({ action: 'APPROVE', objectType: 'DESTROY_BATCH', objectIdPath: 'params.id' })
  public async approve(@Param('id') id: string): Promise<DestroyBatchDto> {
    return this.service.approve(id);
  }

  /** 执行销毁 */
  @Post('batches/:id/execute')
  @RequirePerm({ domain: 'RECYCLE', op: 'DELETE', checkScope: false, objectType: 'DESTROY_BATCH' })
  @Audit({ action: 'DELETE', objectType: 'DESTROY_BATCH', objectIdPath: 'params.id' })
  public async execute(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<DestroyExecuteResult> {
    return this.service.execute(id, userId ?? null);
  }

  /** 销毁明细/留痕 */
  @Get('batches/:id/entries')
  @RequirePerm({ domain: 'RECYCLE', op: 'READ', checkScope: false, objectType: 'DESTROY_BATCH' })
  public async entries(@Param('id') id: string): Promise<DestroyEntryDto[]> {
    return this.service.entries(id);
  }
}
