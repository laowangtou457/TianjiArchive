import { Controller, Get } from '@nestjs/common';
import type { DashboardSummary, PermissionSnapshot } from '@tianji/shared';
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
}
