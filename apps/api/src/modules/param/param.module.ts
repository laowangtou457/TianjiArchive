import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemParam } from '../../infra/database/entities/system-param.entity';
import { ParamService } from './param.service';
import { ParamManageController, PublicParamController } from './param.controller';

/**
 * 业务参数模块（F-14 / PR-P1 ~ PR-P8）。
 *
 * 全局导出：借阅、预览、回收站、认证等模块都需要读参数，
 * 让每个模块各自 import 一份只会造成重复实例（进程缓存分裂、订阅重复）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([SystemParam])],
  controllers: [ParamManageController, PublicParamController],
  providers: [ParamService],
  exports: [ParamService],
})
export class ParamModule {}
