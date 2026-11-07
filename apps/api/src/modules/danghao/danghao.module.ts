import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DanghaoRuleService } from './rule.service';
import { DanghaoSequenceService } from './sequence.service';
import { DanghaoRuleController } from './rule.controller';
import { DanghaoRule } from '../../infra/database/entities/danghao-rule.entity';
import { DanghaoSequence } from '../../infra/database/entities/danghao-sequence.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { OrgNode } from '../../infra/database/entities/org-node.entity';
import { Category } from '../../infra/database/entities/category.entity';

/**
 * 档号模块：规则引擎 + 序列分配。
 * 被 ArchiveModule 复用（生成档号），故导出两个 service。
 */
@Module({
  imports: [TypeOrmModule.forFeature([DanghaoRule, DanghaoSequence, Fonds, OrgNode, Category])],
  controllers: [DanghaoRuleController],
  providers: [DanghaoRuleService, DanghaoSequenceService],
  exports: [DanghaoRuleService, DanghaoSequenceService],
})
export class DanghaoModule {}
