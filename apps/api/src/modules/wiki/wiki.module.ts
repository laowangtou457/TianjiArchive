import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ItemRelation,
  ArchiveItem,
  WikiSpace,
  WikiPage,
  WikiPageVersion,
  WikiChunk,
} from '../../infra/database/entities';
import { RagModule } from '../rag/rag.module';
import { WikiController } from './wiki.controller';
import { WikiService } from './wiki.service';
import { WikiPagesController } from './wiki-pages.controller';
import { WikiPagesService } from './wiki-pages.service';

/**
 * LLM Wiki 模块（P4）。
 *
 * 两个服务各管一边：
 *   - WikiService：围绕**档案条目**的知识网（关联 / 主题聚合 / 条目摘要），
 *     事实来源是档案元数据与既有分块，不走 TopK 召回；
 *   - WikiPagesService：**人编写的**知识页面库（空间 / 页面树 / 版本回滚 /
 *     页面向量问答），事实来源是编研笔记，切片入 wiki_chunk。
 *
 * 依赖 RagModule 复用 LlmGateway 与 OllamaEmbeddingProvider（生成网关与嵌入），
 * 不依赖其检索能力 —— 两边的召回域必须隔离（wiki_chunk ≠ item_chunk）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ItemRelation, ArchiveItem, WikiSpace, WikiPage, WikiPageVersion, WikiChunk]),
    RagModule,
  ],
  controllers: [WikiController, WikiPagesController],
  providers: [WikiService, WikiPagesService],
  exports: [WikiService, WikiPagesService],
})
export class WikiModule {}
