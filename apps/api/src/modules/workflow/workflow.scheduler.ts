import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WorkflowService } from './workflow.service';

/**
 * 审批超时巡检（每小时第 20 分）。
 *
 * 只做**告警**，不自动通过/跳过：档案审批是责任行为，
 * 机器代替人推进会把「没人看」变成「视为同意」，合规上不可接受。
 */
@Injectable()
export class WorkflowScheduler {
  private readonly logger = new Logger(WorkflowScheduler.name);

  public constructor(private readonly workflowService: WorkflowService) {}

  @Cron('20 0 * * * *', { name: 'workflow-timeout-scan' })
  public async scanTimeouts(): Promise<void> {
    try {
      const count = await this.workflowService.scanTimeouts();
      if (count > 0) this.logger.warn(`审批超时待办：${count} 条`);
    } catch (err) {
      this.logger.error(`审批超时巡检失败: ${(err as Error).message}`);
    }
  }
}
