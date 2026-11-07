import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecycleBin } from '../../infra/database/entities/recycle-bin.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { RecycleController } from './recycle.controller';
import { RecycleService } from './recycle.service';
import { RecycleScheduler } from './recycle.scheduler';
import { ParamModule } from '../param/param.module';

/**
 * 回收站模块（F-18）。
 *
 * RecycleService 同时导出给 ArchiveService 使用（删除时登记）；
 * 保留天数来自 `recycle.retention_days` 参数（D-2 增量生效）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RecycleBin, ArchiveItem, Volume, ElectronicFile, AppUser]),
    ParamModule,
  ],
  controllers: [RecycleController],
  providers: [RecycleService, RecycleScheduler],
  exports: [RecycleService],
})
export class RecycleModule {}
