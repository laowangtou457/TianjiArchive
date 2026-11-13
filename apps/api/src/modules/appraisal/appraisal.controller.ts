import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  APPRAISAL_DECISION_VALUES,
  RETENTION_VALUES,
  type AppraisalDecision,
  type AppraisalEntryDto,
  type AppraisalExecuteResult,
  type AppraisalTaskDto,
  type PermissionSnapshot,
  type Retention,
} from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AppraisalService } from './appraisal.service';

export class CreateAppraisalBodyDto {
  @IsString() @IsNotEmpty() @MaxLength(200) public name!: string;
  @IsOptional() @IsUUID() public fondsId?: string | null;
  @Type(() => Number) @IsInt() @Min(1900) public yearFrom!: number;
  @Type(() => Number) @IsInt() @Min(1900) public yearTo!: number;
  @IsOptional() @IsArray() @IsIn(RETENTION_VALUES, { each: true }) public retentions?: Retention[];
  @IsOptional() @IsString() public categoryCode?: string | null;
  @IsOptional() @IsBoolean() public dueOnly?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) public basis?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) public remark?: string | null;
}

export class DecideAppraisalBodyDto {
  @IsArray() @IsUUID('4', { each: true }) public ids!: string[];
  @IsIn(APPRAISAL_DECISION_VALUES.filter((d) => d !== 'PENDING'))
  public decision!: Exclude<AppraisalDecision, 'PENDING'>;
  @IsOptional() @IsIn(RETENTION_VALUES) public retentionAfter?: Retention | null;
  @IsOptional() @IsString() @MaxLength(500) public reason?: string | null;
}

export class AppraisalQueryDto {
  @IsOptional() @IsString() public status?: string;
  @IsOptional() @IsString() public keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
}

export class AppraisalEntryQueryDto {
  @IsOptional() @IsEnum(Object) public decision?: string;
  @IsOptional() @IsString() public keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
}

/**
 * 档案鉴定控制器（F-19）。
 *
 * 权限：APPRAISAL 域（PRD 权限矩阵中 R1 完全、R0 只读配置）。
 * 数据范围与密级：任务列表按全宗范围过滤；明细处置按任务归属，不重复判密级
 * （能建鉴定任务的人本就持有 APPRAISAL 写权限，且鉴定对象不含全文）。
 */
@Controller('appraisal')
export class AppraisalController {
  public constructor(private readonly appraisalService: AppraisalService) {}

  @Get('tasks')
  @RequirePerm({ domain: 'APPRAISAL', op: 'READ', checkScope: false, objectType: 'APPRAISAL_TASK' })
  public async list(
    @Query() q: AppraisalQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: AppraisalTaskDto[]; total: number; page: number; size: number }> {
    return this.appraisalService.list(q, user as PermissionSnapshot);
  }

  @Post('tasks')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'APPRAISAL_TASK' })
  @Audit({ action: 'CREATE', objectType: 'APPRAISAL_TASK' })
  public async create(
    @Body() dto: CreateAppraisalBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppraisalTaskDto> {
    return this.appraisalService.create(dto, user as PermissionSnapshot);
  }

  @Get('tasks/:id')
  @RequirePerm({ domain: 'APPRAISAL', op: 'READ', checkScope: false, objectType: 'APPRAISAL_TASK' })
  public async detail(@Param('id') id: string): Promise<AppraisalTaskDto> {
    return this.appraisalService.detail(id);
  }

  @Post('tasks/:id/regenerate')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'APPRAISAL_TASK' })
  @Audit({ action: 'UPDATE', objectType: 'APPRAISAL_TASK', objectIdPath: 'params.id' })
  public async regenerate(@Param('id') id: string): Promise<AppraisalTaskDto> {
    return this.appraisalService.regenerate(id);
  }

  @Post('tasks/:id/cancel')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'APPRAISAL_TASK' })
  @Audit({ action: 'VOID', objectType: 'APPRAISAL_TASK', objectIdPath: 'params.id', mandatory: true })
  public async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppraisalTaskDto> {
    return this.appraisalService.cancel(id, user as PermissionSnapshot);
  }

  @Get('tasks/:id/entries')
  @RequirePerm({ domain: 'APPRAISAL', op: 'READ', checkScope: false, objectType: 'APPRAISAL_TASK' })
  public async entries(
    @Param('id') id: string,
    @Query() q: AppraisalEntryQueryDto,
  ): Promise<{ items: AppraisalEntryDto[]; total: number; page: number; size: number }> {
    return this.appraisalService.listEntries(id, q);
  }

  @Post('tasks/:id/decide')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'APPRAISAL_TASK' })
  @Audit({ action: 'UPDATE', objectType: 'APPRAISAL_TASK', objectIdPath: 'params.id' })
  public async decide(
    @Param('id') id: string,
    @Body() dto: DecideAppraisalBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ updated: number }> {
    return this.appraisalService.decide(id, dto, user as PermissionSnapshot);
  }

  @Post('tasks/:id/execute')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'APPRAISAL_TASK' })
  @Audit({ action: 'UPDATE', objectType: 'APPRAISAL_TASK', objectIdPath: 'params.id', mandatory: true })
  public async execute(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppraisalExecuteResult> {
    return this.appraisalService.execute(id, user as PermissionSnapshot);
  }

  @Post('tasks/:id/submit-destroy')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'APPRAISAL_TASK' })
  @Audit({ action: 'APPROVE', objectType: 'APPRAISAL_TASK', objectIdPath: 'params.id', mandatory: true })
  public async submitDestroy(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppraisalTaskDto> {
    return this.appraisalService.submitDestroy(id, user as PermissionSnapshot);
  }
}
