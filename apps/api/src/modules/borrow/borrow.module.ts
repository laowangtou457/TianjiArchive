import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BorrowOrder } from '../../infra/database/entities/borrow-order.entity';
import { BorrowApproval } from '../../infra/database/entities/borrow-approval.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { AuditModule } from '../audit/audit.module';
import { ParamModule } from '../param/param.module';
import { BorrowController } from './borrow.controller';
import { BorrowService } from './borrow.service';
import { BorrowScheduler } from './borrow.scheduler';

/**
 * 借阅模块（F-06）。
 *
 * 依赖：
 *  - AccessFilterBuilder（全局）：档案可访问性校验，权限四要素复用同一点位；
 *  - AuditLogService：审计留痕 / 逾期追溯；
 *  - ParamService：借阅阈值（总借期 / 续借次数 / 单次续借天数 / 默认借期 / 提醒天数）
 *    全部来自 sys_param，杜绝策略硬编码（PR-P1）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BorrowOrder, BorrowApproval, ArchiveItem, AppUser]),
    AuditModule,
    ParamModule,
  ],
  controllers: [BorrowController],
  providers: [BorrowService, BorrowScheduler],
  exports: [BorrowService],
})
export class BorrowModule {}
