import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  OPEN_DECISION_VALUES,
  SECURITY_LEVEL_VALUES,
  type CreateOpenBatchDto,
  type OpenApplyResult,
  type OpenBatchDto,
  type OpenDecision,
  type OpenReviewDto,
  type PermissionSnapshot,
  type ReviewOpenBatchDto,
  type SecurityLevel,
} from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { OpenService } from './open.service';

export class CreateOpenBatchBodyDto {
  @IsString() @IsNotEmpty() @MaxLength(200) public name!: string;
  @IsOptional() @IsUUID() public fondsId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() public yearFrom?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() public yearTo?: number | null;
  @IsOptional() @IsArray() @IsIn(SECURITY_LEVEL_VALUES, { each: true })
  public securityLevels?: SecurityLevel[];
  @IsOptional() public unopenedOnly?: boolean;
}

export class ReviewOpenBodyDto {
  @IsArray() @IsUUID('4', { each: true }) public ids!: string[];
  @IsIn(OPEN_DECISION_VALUES.filter((d) => d !== 'PENDING'))
  public decision!: Exclude<OpenDecision, 'PENDING'>;
  @IsOptional() @IsString() @MaxLength(500) public reason?: string | null;
}

export class OpenBatchQueryDto {
  @IsOptional() @IsString() public status?: string;
  @IsOptional() @IsString() public keyword?: string;
  @IsOptional() @IsString() public fondsId?: string;
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
}

export class OpenReviewQueryDto {
  @IsOptional() @IsString() public decision?: string;
  @IsOptional() @IsString() public keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
}

/**
 * 开放管理控制器（F-19）。
 *
 * 状态机：DRAFT → IN_PROGRESS（审核）→ APPROVING（待审批）→ FINISHED（已开放）；
 * 旁路 CANCELLED。审批由通用审批流引擎承载（流程编码 WF-OPEN-BATCH）。
 */
@Controller('open')
export class OpenController {
  public constructor(private readonly openService: OpenService) {}

  @Get('batches')
  @RequirePerm({ domain: 'APPRAISAL', op: 'READ', checkScope: false, objectType: 'OPEN_BATCH' })
  public async list(
    @Query() q: OpenBatchQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: OpenBatchDto[]; total: number; page: number; size: number }> {
    return this.openService.list(q, user as PermissionSnapshot);
  }

  @Post('batches')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'OPEN_BATCH' })
  @Audit({ action: 'CREATE', objectType: 'OPEN_BATCH' })
  public async create(
    @Body() dto: CreateOpenBatchBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OpenBatchDto> {
    return this.openService.create(dto as CreateOpenBatchDto, user as PermissionSnapshot);
  }

  @Get('batches/:id')
  @RequirePerm({ domain: 'APPRAISAL', op: 'READ', checkScope: false, objectType: 'OPEN_BATCH' })
  public async detail(@Param('id') id: string): Promise<OpenBatchDto> {
    return this.openService.detail(id);
  }

  @Post('batches/:id/cancel')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'OPEN_BATCH' })
  @Audit({ action: 'VOID', objectType: 'OPEN_BATCH', objectIdPath: 'params.id', mandatory: true })
  public async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OpenBatchDto> {
    return this.openService.cancel(id, user as PermissionSnapshot);
  }

  @Get('batches/:id/reviews')
  @RequirePerm({ domain: 'APPRAISAL', op: 'READ', checkScope: false, objectType: 'OPEN_BATCH' })
  public async reviews(
    @Param('id') id: string,
    @Query() q: OpenReviewQueryDto,
  ): Promise<{ items: OpenReviewDto[]; total: number; page: number; size: number }> {
    return this.openService.listReviews(id, q);
  }

  @Post('batches/:id/reviews')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'OPEN_BATCH' })
  @Audit({ action: 'UPDATE', objectType: 'OPEN_BATCH', objectIdPath: 'params.id' })
  public async review(
    @Param('id') id: string,
    @Body() dto: ReviewOpenBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ updated: number }> {
    return this.openService.review(id, dto as ReviewOpenBatchDto, user as PermissionSnapshot);
  }

  @Post('batches/:id/submit')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'OPEN_BATCH' })
  @Audit({ action: 'APPROVE', objectType: 'OPEN_BATCH', objectIdPath: 'params.id', mandatory: true })
  public async submit(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OpenBatchDto> {
    return this.openService.submit(id, user as PermissionSnapshot);
  }

  /**
   * 手动应用开放标识。
   * 正常路径由审批回调触发；此入口用于回调失败（如数据库瞬断）后重试，
   * 幂等设计保证重复调用安全。
   */
  @Post('batches/:id/apply')
  @RequirePerm({ domain: 'APPRAISAL', op: 'WRITE', checkScope: false, objectType: 'OPEN_BATCH' })
  @Audit({ action: 'UPDATE', objectType: 'OPEN_BATCH', objectIdPath: 'params.id', mandatory: true })
  public async apply(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OpenApplyResult> {
    return this.openService.applyBatch(id, user.userId);
  }

  /** 再审查队列（跨批次） */
  @Get('rereview')
  @RequirePerm({ domain: 'APPRAISAL', op: 'READ', checkScope: false, objectType: 'OPEN_BATCH' })
  public async rereview(
    @Query() q: OpenReviewQueryDto,
  ): Promise<{ items: OpenReviewDto[]; total: number; page: number; size: number }> {
    return this.openService.rereviewQueue(q);
  }
}
