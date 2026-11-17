import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArchiveModule } from '../archive/archive.module';
import { DestroyBatch } from '../../infra/database/entities/destroy-batch.entity';
import { DestroyEntry } from '../../infra/database/entities/destroy-entry.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { RecycleBin } from '../../infra/database/entities/recycle-bin.entity';
import { DestroyController } from './destroy.controller';
import { DestroyService } from './destroy.service';

/**
 * 销毁批次模块 P5。
 * 依赖 ArchiveModule（复用 ArchiveService.softDeleteItem 完成软删除 + 回收站留痕）。
 * 需在 AppModule.imports 注册；对应实体需纳入 DataSource 实体清单（见交付说明）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([DestroyBatch, DestroyEntry, ArchiveItem, RecycleBin]), ArchiveModule],
  controllers: [DestroyController],
  providers: [DestroyService],
  exports: [DestroyService],
})
export class DestroyModule {}
