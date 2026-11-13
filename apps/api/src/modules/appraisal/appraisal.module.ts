import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppraisalTask } from '../../infra/database/entities/appraisal-task.entity';
import { AppraisalEntry } from '../../infra/database/entities/appraisal-entry.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { RecycleModule } from '../recycle/recycle.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { AppraisalController } from './appraisal.controller';
import { AppraisalService } from './appraisal.service';

/**
 * 档案鉴定模块（F-19）。
 *
 * 依赖：
 *  - RecycleModule：销毁走软删除 + 回收站（可还原），不做物理删除；
 *  - WorkflowModule：销毁必须先过审批（引擎不认识鉴定表，通过回调反向落库）；
 *  - EsIndexerService（全局）：处置改变保管期限/删除标记后同步索引。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AppraisalTask, AppraisalEntry, ArchiveItem, Volume, Fonds, AppUser]),
    RecycleModule,
    WorkflowModule,
  ],
  controllers: [AppraisalController],
  providers: [AppraisalService],
  exports: [AppraisalService],
})
export class AppraisalModule {}
