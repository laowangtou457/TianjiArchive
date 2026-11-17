import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImportBatch } from '../../infra/database/entities/import-batch.entity';
import { DataInfoController } from './datainfo.controller';
import { DataInfoService } from './datainfo.service';

/**
 * 数据导入模块 P5。
 * 需在 AppModule.imports 注册；对应实体需纳入 DataSource 实体清单（见交付说明）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ImportBatch])],
  controllers: [DataInfoController],
  providers: [DataInfoService],
  exports: [DataInfoService],
})
export class DataInfoModule {}
