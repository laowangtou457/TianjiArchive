import { Controller, Get } from '@nestjs/common';
import type {
  DashboardStats,
  DashboardSummary,
  DashboardTodo,
  PermissionSnapshot,
} from '@tianji/shared';
import { CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DashboardService } from './dashboard.service';

/** 工作台控制器（F-13） */
@Controller('dashboard')
export class DashboardController {
  public constructor(private readonly dashboardService: DashboardService) {}

  /** 工作台数据源（权限过滤后） */
  @Get('summary')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'DASHBOARD' })
  public async summary(@CurrentUser() user: AuthenticatedUser): Promise<DashboardSummary> {
    return this.dashboardService.summary(user as PermissionSnapshot);
  }

  /** 逐条待办事项（按角色/功能域/数据范围过滤，可跳转处理） */
  @Get('todos')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'DASHBOARD' })
  public async todos(@CurrentUser() user: AuthenticatedUser): Promise<DashboardTodo[]> {
    return this.dashboardService.todos(user as PermissionSnapshot);
  }

  /** 数据统计四页签（档案 / 原文 / 利用 / 最近一周登录） */
  @Get('stats')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'DASHBOARD' })
  public async stats(@CurrentUser() user: AuthenticatedUser): Promise<DashboardStats> {
    return this.dashboardService.stats(user as PermissionSnapshot);
  }
}
