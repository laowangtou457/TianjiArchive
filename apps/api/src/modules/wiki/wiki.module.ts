import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ItemRelation } from '../../infra/database/entities/item-relation.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { RagModule } from '../rag/rag.module';
import { WikiController } from './wiki.controller';
import { WikiService } from './wiki.service';

/**
 * LLM Wiki 模块（P4）。
 *
 * 依赖 RagModule 仅为复用 LlmGateway（生成网关），不依赖其检索能力 ——
 * Wiki 的事实来源是条目元数据与既有分块，不走 TopK 召回。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ItemRelation, ArchiveItem]), RagModule],
  controllers: [WikiController],
  providers: [WikiService],
  exports: [WikiService],
})
export class WikiModule {}
