import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DictService } from './dict.service';
import { DictController, ParamController } from './dict.controller';
import { DictItem } from '../../infra/database/entities/dict-item.entity';
import { SystemParam } from '../../infra/database/entities/system-param.entity';
import { ParamModule } from '../param/param.module';

/**
 * 字典模块（F-14）。
 *
 * 参数能力已抽到 ParamModule（唯一实现），本模块仅保留字典与旧参数接口兼容层。
 */
@Module({
  imports: [TypeOrmModule.forFeature([DictItem, SystemParam]), ParamModule],
  controllers: [DictController, ParamController],
  providers: [DictService],
  exports: [DictService],
})
export class DictModule {}
