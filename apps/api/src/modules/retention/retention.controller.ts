import { Body, Controller, Delete, Get, Patch, Param, Post } from '@nestjs/common';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Audit, RequirePerm } from '../../common/decorators/require-perm.decorator';
import { RetentionService, type RetentionPlanDto } from './retention.service';

/** 新增期限方案请求体 */
export class CreateRetentionPlanBodyDto {
  @IsString()
  @IsNotEmpty({ message: '期限代码不能为空' })
  @MaxLength(32)
  public code!: string;

  @IsString()
  @IsNotEmpty({ message: '期限名称不能为空' })
  @MaxLength(100)
  public name!: string;

  @IsInt()
  public years!: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  public level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public description?: string | null;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

/** 编辑期限方案请求体（全部可选） */
export class UpdateRetentionPlanBodyDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  public code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  public name?: string;

  @IsOptional()
  @IsInt()
  public years?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  public level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public description?: string | null;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

/**
 * 保管期限表接口 P5（DANGHAO_RULE 域）。
 */
@Controller('retention')
export class RetentionController {
  constructor(private readonly service: RetentionService) {}

  @Get('plans')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'READ', checkScope: false, objectType: 'RETENTION_PLAN' })
  public async listPlans(): Promise<RetentionPlanDto[]> {
    return this.service.listPlans();
  }

  @Post('plans')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'WRITE', checkScope: false, objectType: 'RETENTION_PLAN' })
  @Audit({ action: 'CREATE', objectType: 'RETENTION_PLAN' })
  public async create(@Body() dto: CreateRetentionPlanBodyDto): Promise<RetentionPlanDto> {
    return this.service.create(dto);
  }

  @Patch('plans/:id')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'WRITE', checkScope: false, objectType: 'RETENTION_PLAN' })
  @Audit({ action: 'UPDATE', objectType: 'RETENTION_PLAN', objectIdPath: 'params.id' })
  public async update(
    @Param('id') id: string,
    @Body() dto: UpdateRetentionPlanBodyDto,
  ): Promise<RetentionPlanDto> {
    return this.service.update(id, dto);
  }

  @Delete('plans/:id')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'DELETE', checkScope: false, objectType: 'RETENTION_PLAN' })
  @Audit({ action: 'DELETE', objectType: 'RETENTION_PLAN', objectIdPath: 'params.id' })
  public async remove(@Param('id') id: string): Promise<{ removed: boolean }> {
    return this.service.remove(id);
  }
}
