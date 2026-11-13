import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import {
  BizException,
  ErrorCode,
  WorkflowAction,
  WorkflowBizType,
  type StartWorkflowDto,
  type WorkflowDefDto,
  type WorkflowInstanceDto,
  type WorkflowNodeDto,
} from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { WorkflowService, type WorkflowInstanceQuery } from './workflow.service';


/** 直接用共享 DTO 做类型，控制器层只做「必填校验」，避免两套定义漂移 */
export class CreateWorkflowDefBodyDto {
  @IsString() @IsNotEmpty() @MaxLength(60) public code!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) public name!: string;
  @IsEnum(WorkflowBizType) public bizType!: WorkflowBizType;
  @IsOptional() @IsString() @MaxLength(500) public description?: string | null;
  @IsOptional() @IsBoolean() public enabled?: boolean;
  @IsOptional() public nodes?: WorkflowNodeDto[];
}

export class UpdateWorkflowDefBodyDto {
  @IsOptional() @IsString() @MaxLength(120) public name?: string;
  @IsOptional() @IsString() @MaxLength(500) public description?: string | null;
  @IsOptional() @IsBoolean() public enabled?: boolean;
  @IsOptional() public nodes?: WorkflowNodeDto[];
}

export class StartWorkflowBodyDto {
  @IsEnum(WorkflowBizType) public bizType!: WorkflowBizType;
  @IsString() @IsNotEmpty() public bizId!: string;
  @IsString() @IsNotEmpty() @MaxLength(200) public title!: string;
  @IsOptional() @IsString() @MaxLength(500) public summary?: string | null;
  @IsOptional() public payload?: Record<string, unknown>;
}

export class WorkflowActionBodyDto {
  @IsEnum(WorkflowAction) public action!: WorkflowAction;
  @IsOptional() @IsString() @MaxLength(500) public opinion?: string;
}

export class WorkflowQueryDto {
  @IsOptional() @IsEnum(WorkflowBizType) public bizType?: WorkflowBizType;
  @IsOptional() @IsString() public status?: string;
  @IsOptional() @IsString() public bizId?: string;
  @IsOptional() @IsString() public mine?: string;
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
}

/**
 * 审批流控制器（F-07）。
 *
 * 权限口径：
 *  - 流程定义（增删改查）→ PARAM 域（系统参数配置是 R0 的活）；
 *  - 实例与我待办 → 不绑定具体业务域（跨业务通用），仅要求登录；
 *    实际能否处理由 Service 按「环节角色 + 环节权限域」二次裁决。
 */
@Controller('workflow')
export class WorkflowController {
  public constructor(private readonly workflowService: WorkflowService) {}

  // ------------------------------------------------------------------ 定义
  @Get('defs')
  @RequirePerm({ domain: 'PARAM', op: 'READ', checkScope: false, objectType: 'WORKFLOW_DEF' })
  public async listDefs(): Promise<WorkflowDefDto[]> {
    return this.workflowService.listDefs();
  }

  @Post('defs')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'WORKFLOW_DEF' })
  @Audit({ action: 'CREATE', objectType: 'WORKFLOW_DEF', objectIdPath: 'body.code' })
  public async createDef(
    @Body() dto: CreateWorkflowDefBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkflowDefDto> {
    return this.workflowService.createDef(
      { ...dto, nodes: dto.nodes ?? [] },
      user.userId,
    );
  }

  @Patch('defs/:id')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'WORKFLOW_DEF' })
  @Audit({ action: 'UPDATE', objectType: 'WORKFLOW_DEF', objectIdPath: 'params.id' })
  public async updateDef(
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDefBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkflowDefDto> {
    return this.workflowService.updateDef(id, dto, user.userId);
  }

  @Delete('defs/:id')
  @RequirePerm({ domain: 'PARAM', op: 'DELETE', checkScope: false, objectType: 'WORKFLOW_DEF' })
  @Audit({ action: 'DELETE', objectType: 'WORKFLOW_DEF', objectIdPath: 'params.id' })
  public async deleteDef(@Param('id') id: string): Promise<{ deleted: boolean }> {
    return this.workflowService.deleteDef(id);
  }

  // ------------------------------------------------------------------ 实例
  @Get('instances')
  public async listInstances(
    @Query() q: WorkflowQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: WorkflowInstanceDto[]; total: number; page: number; size: number }> {
    const query: WorkflowInstanceQuery = {
      bizType: q.bizType,
      status: q.status,
      bizId: q.bizId,
      mine: q.mine === '1' || q.mine === 'true',
      page: q.page,
      size: q.size,
    };
    return this.workflowService.list(query, user);
  }

  @Get('instances/:id')
  public async detailInstance(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkflowInstanceDto> {
    const dto = await this.workflowService.detail(id, user);
    if (!dto) throw new BizException(ErrorCode.NOT_FOUND, '审批实例不存在');
    return dto;
  }

  /** 发起审批（业务模块内部也会直接调用 service，此端点为通用入口/联调用） */
  @Post('instances')
  @Audit({ action: 'CREATE', objectType: 'WORKFLOW_INSTANCE', objectIdPath: 'body.bizId' })
  public async start(
    @Body() dto: StartWorkflowBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkflowInstanceDto> {
    return this.workflowService.start(dto as StartWorkflowDto, user);
  }

  @Post('instances/:id/action')
  @RequirePerm({
    domain: 'APPRAISAL',
    op: 'APPROVE',
    checkScope: false,
    altPerm: { domain: 'BORROW_APPROVE', op: 'APPROVE' },
    objectType: 'WORKFLOW_INSTANCE',
  })
  @Audit({ action: 'APPROVE', objectType: 'WORKFLOW_INSTANCE', objectIdPath: 'params.id' })
  public async act(
    @Param('id') id: string,
    @Body() dto: WorkflowActionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkflowInstanceDto> {
    return this.workflowService.act(
      id,
      { action: dto.action, opinion: dto.opinion ?? '' },
      user,
    );
  }

  @Post('instances/:id/cancel')
  @Audit({ action: 'VOID', objectType: 'WORKFLOW_INSTANCE', objectIdPath: 'params.id' })
  public async cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkflowInstanceDto> {
    return this.workflowService.cancel(id, user, body?.reason);
  }

  /** 我的待办 */
  @Get('tasks/my')
  public async myTasks(@CurrentUser() user: AuthenticatedUser) {
    return this.workflowService.myTasks(user);
  }

  /** 某业务对象的审批轨迹（业务页面内嵌用） */
  @Get('biz/:bizType/:bizId')
  public async forBiz(
    @Param('bizType') bizType: WorkflowBizType,
    @Param('bizId') bizId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkflowInstanceDto | null> {
    const inst = await this.workflowService.findForBiz(bizType, bizId);
    if (!inst) return null;
    return this.workflowService.detail(inst.id, user);
  }
}
