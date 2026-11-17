import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RetentionPlan } from '../../infra/database/entities/retention-plan.entity';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

/**
 * 保管期限表模块 P5。
 * 需在 AppModule.imports 注册；对应实体需纳入 DataSource 实体清单（见交付说明）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([RetentionPlan])],
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
