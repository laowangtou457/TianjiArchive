import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import {
  ApprovalAction,
  BorrowMode,
  BorrowStatus,
  type BorrowOrderDto,
  type BorrowStatsReport,
} from '@tianji/shared';
import { Audit, CurrentUser, Public, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { BorrowService, type BorrowRulesDto } from './borrow.service';

/** 创建借阅申请 DTO */
export class CreateBorrowBodyDto {
  @IsUUID()
  public itemId!: string;

  @IsString()
  @MinLength(5, { message: '借阅目的至少 5 个字' })
  @MaxLength(500)
  public purpose!: string;

  @IsEnum(BorrowMode)
  public mode!: BorrowMode;

  /** 预计归还日期 YYYY-MM-DD */
  @IsString()
  @IsNotEmpty()
  public expectReturn!: string;
}

/** 审批 DTO：意见必填 */
export class ApproveBorrowBodyDto {
  @IsEnum(ApprovalAction)
  public action!: ApprovalAction;

  @IsString()
  @MinLength(2, { message: '审批意见必填（至少 2 个字）' })
  @MaxLength(500)
  public opinion!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  public level?: number;
}

/** 归还 DTO */
export class ReturnBorrowBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public remark?: string;
}

/** 列表查询 DTO */
export class BorrowQueryBodyDto {
  @IsOptional() @Type(() => Number) @IsInt() public page?: number;
  @IsOptional() @Type(() => Number) @IsInt() public size?: number;
  /** 逗号分隔的多个状态 */
  @IsOptional() @IsString() public status?: string;
  @IsOptional() @IsUUID() public applicantId?: string;
  @IsOptional() @IsUUID() public itemId?: string;
  @IsOptional() @IsString() public mine?: string;
  @IsOptional() @IsString() public keyword?: string;
  @IsOptional() @IsString() public overdueOnly?: string;
}

/**
 * 借阅控制器（F-06）。
 *
 * 审批与归还均强制留痕（硬性验收要点 4：借阅动作必须进操作日志）。
 */
@Controller('borrow')
export class BorrowController {
  public constructor(private readonly borrowService: BorrowService) {}

  /**
   * 借阅规则（前端预填与提示文案）。
   *
   * 公开接口：前端借阅申请页需要在**未持有 PARAM 权限**时拿到当前口径
   * （默认借期、可续借次数、单次上限），否则页面只能硬编码，
   * 会与后端校验口径漂移（PR-P1 的直接动因）。
   * 返回内容不含任何敏感信息，仅业务阈值。
   */
  @Get('config')
  @Public()
  public async config(): Promise<BorrowRulesDto> {
    return this.borrowService.config();
  }

  /** 提交借阅申请 */
  @Post('orders')
  @RequirePerm({ domain: 'BORROW_APPLY', op: 'WRITE', checkScope: false, objectType: 'BORROW_ORDER' })
  @Audit({ action: 'CREATE', objectType: 'BORROW_ORDER', objectIdPath: 'body.itemId' })
  public async create(
    @Body() dto: CreateBorrowBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BorrowOrderDto> {
    return this.borrowService.create(dto, user);
  }

  /** 借阅单列表 */
  @Get('orders')
  @RequirePerm({ domain: 'BORROW_APPLY', op: 'READ', checkScope: false, objectType: 'BORROW_ORDER' })
  public async list(
    @Query() query: BorrowQueryBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: BorrowOrderDto[]; total: number; page: number; size: number }> {
    const statuses = query.status
      ? (query.status.split(',').filter(Boolean) as BorrowStatus[])
      : undefined;
    return this.borrowService.list(
      {
        page: query.page,
        size: query.size,
        status: statuses,
        applicantId: query.applicantId,
        itemId: query.itemId,
        keyword: query.keyword,
        mine: query.mine !== 'false',
        overdueOnly: query.overdueOnly === 'true',
      },
      user,
    );
  }

  /** 逾期名单（管理员/审批人视角） */
  @Get('orders/overdue')
  @RequirePerm({ domain: 'BORROW_RETURN', op: 'READ', checkScope: false, objectType: 'BORROW_ORDER' })
  public async overdue(@CurrentUser() user: AuthenticatedUser): Promise<BorrowOrderDto[]> {
    const res = await this.borrowService.list(
      { status: [BorrowStatus.OVERDUE], mine: false, size: 100 },
      user,
    );
    return res.items;
  }

  /** 借阅单详情 */
  @Get('orders/:id')
  @RequirePerm({ domain: 'BORROW_APPLY', op: 'READ', checkScope: false, objectType: 'BORROW_ORDER' })
  public async detail(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BorrowOrderDto> {
    return this.borrowService.detail(id, user);
  }

  /** 审批（通过/驳回），强制留痕 */
  @Post('orders/:id/approve')
  @RequirePerm({ domain: 'BORROW_APPROVE', op: 'APPROVE', checkScope: false, objectType: 'BORROW_ORDER' })
  @Audit({ action: 'APPROVE', objectType: 'BORROW_ORDER', mandatory: true, objectIdPath: 'params.id' })
  public async approve(
    @Param('id') id: string,
    @Body() dto: ApproveBorrowBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BorrowOrderDto> {
    return this.borrowService.approve(id, dto, user);
  }

  /** 借出登记 */
  @Post('orders/:id/lend')
  @RequirePerm({ domain: 'BORROW_RETURN', op: 'WRITE', checkScope: false, objectType: 'BORROW_ORDER' })
  @Audit({ action: 'UPDATE', objectType: 'BORROW_ORDER', objectIdPath: 'params.id' })
  public async lend(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BorrowOrderDto> {
    return this.borrowService.lend(id, user);
  }

  /** 归还登记，强制留痕 */
  @Post('orders/:id/return')
  @RequirePerm({ domain: 'BORROW_RETURN', op: 'WRITE', checkScope: false, objectType: 'BORROW_ORDER' })
  @Audit({ action: 'UPDATE', objectType: 'BORROW_ORDER', mandatory: true, objectIdPath: 'params.id' })
  public async giveBack(
    @Param('id') id: string,
    @Body() dto: ReturnBorrowBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BorrowOrderDto> {
    return this.borrowService.giveBack(id, dto.remark, user);
  }

  /** 撤销申请（本人） */
  @Patch('orders/:id/cancel')
  @RequirePerm({ domain: 'BORROW_APPLY', op: 'WRITE', checkScope: false, objectType: 'BORROW_ORDER' })
  @Audit({ action: 'UPDATE', objectType: 'BORROW_ORDER', objectIdPath: 'params.id' })
  public async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BorrowOrderDto> {
    return this.borrowService.cancel(id, user);
  }

  /** 续借（本人，限 1 次） */
  @Patch('orders/:id/renew')
  @RequirePerm({ domain: 'BORROW_APPLY', op: 'WRITE', checkScope: false, objectType: 'BORROW_ORDER' })
  @Audit({ action: 'UPDATE', objectType: 'BORROW_ORDER', objectIdPath: 'params.id' })
  public async renew(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BorrowOrderDto> {
    return this.borrowService.renew(id, user);
  }

  /** 借阅统计 */
  @Get('stats')
  @RequirePerm({ domain: 'REPORT', op: 'READ', checkScope: false, objectType: 'BORROW_ORDER' })
  public async stats(@Query('from') from?: string, @Query('to') to?: string): Promise<BorrowStatsReport> {
    return this.borrowService.stats(from, to);
  }
}
