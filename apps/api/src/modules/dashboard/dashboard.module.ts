import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { BorrowOrder } from '../../infra/database/entities/borrow-order.entity';
import { SearchHistory } from '../../infra/database/entities/search-history.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/** 工作台模块（F-13） */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ArchiveItem,
      Volume,
      Fonds,
      ElectronicFile,
      BorrowOrder,
      SearchHistory,
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
