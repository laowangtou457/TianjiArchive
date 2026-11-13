import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OpenBatch } from '../../infra/database/entities/open-batch.entity';
import { OpenReview } from '../../infra/database/entities/open-review.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { WorkflowModule } from '../workflow/workflow.module';
import { OpenController } from './open.controller';
import { OpenService } from './open.service';

/**
 * 开放管理模块（F-19）。
 *
 * 与鉴定模块的区别：开放**只改标识**（open_flag/open_scope），不动档案本体；
 * 因此不需要回收站依赖，但同样要走审批流（对外开放是对外承诺）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OpenBatch, OpenReview, ArchiveItem, Fonds, AppUser]),
    WorkflowModule,
  ],
  controllers: [OpenController],
  providers: [OpenService],
  exports: [OpenService],
})
export class OpenModule {}
