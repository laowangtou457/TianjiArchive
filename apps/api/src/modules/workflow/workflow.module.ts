import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowDef } from '../../infra/database/entities/workflow-def.entity';
import { WorkflowNodeRow } from '../../infra/database/entities/workflow-node.entity';
import { WorkflowInstance } from '../../infra/database/entities/workflow-instance.entity';
import { WorkflowTask } from '../../infra/database/entities/workflow-task.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { WorkflowScheduler } from './workflow.scheduler';

/**
 * 审批流引擎模块（F-07）。
 *
 * 依赖边界（重要）：**引擎不认识任何业务表**。
 * 业务模块 → 依赖本模块（发起/查询/注册回调），本模块不反向依赖业务模块，
 * 否则会形成「业务 ⇄ 引擎」循环，Nest 启动期装饰器求值会拿到 undefined。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowDef, WorkflowNodeRow, WorkflowInstance, WorkflowTask, AppUser]),
  ],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowScheduler],
  exports: [WorkflowService],
})
export class WorkflowModule {}
