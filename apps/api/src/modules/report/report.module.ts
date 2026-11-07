import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { Category } from '../../infra/database/entities/category.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { BorrowModule } from '../borrow/borrow.module';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';

/**
 * 统计报表模块（F-07）。
 * 借阅统计复用 BorrowService，保证「报表口径 = 业务口径」。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ArchiveItem, Volume, Fonds, Category, ElectronicFile]),
    BorrowModule,
  ],
  controllers: [ReportController],
  providers: [ReportService],
  exports: [ReportService],
})
export class ReportModule {}
