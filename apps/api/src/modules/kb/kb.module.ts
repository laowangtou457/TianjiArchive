import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { EMBEDDING_PROVIDER, LocalHashEmbeddingProvider, type EmbeddingProvider } from './embedding.provider';
import { EsVectorStore } from './vector.store';
import { KbEsService } from './kb.es';
import { KbIndexer } from './kb.indexer';
import { CHUNK_RETRIEVER, LexicalChunkRetriever } from './kb.retriever';
import { KbScheduler } from './kb.scheduler';

/**
 * 知识库 / 片段检索（F-22，A 档：检索增强，不生成答案）。
 *
 * 设计（架构 §5.6）：
 *   - 路由命名空间 `/api/kb/*` 不变，前端契约无需调整；
 *   - `EmbeddingProvider` / `ChunkRetriever` 均经**令牌注入**，换模型或换检索策略
 *     只改本文件 wiring；
 *   - 检索器按 provider 能力**自动择一**：
 *       `productionReady=false` → 词法 BM25（当前） ；
 *       `productionReady=true`  → 向量召回（接入真实 embedding 后自动生效）。
 *     之所以由能力声明驱动而不是配置开关：配置开关会被"顺手打开"，
 *     而能力声明是代码事实，hash 提供方永远不可能被误当成语义检索。
 *   - 检索前强制走 AccessFilterBuilder，保证密级与数据范围与主检索一致（验收要点 3）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KbEntry])],
  controllers: [KbController],
  providers: [
    KbService,
    KbEsService,
    KbIndexer,
    KbScheduler,
    LocalHashEmbeddingProvider,
    LexicalChunkRetriever,
    EsVectorStore,
    { provide: EMBEDDING_PROVIDER, useExisting: LocalHashEmbeddingProvider },
    {
      provide: CHUNK_RETRIEVER,
      // 能力驱动的选择：hash 提供方（productionReady=false）不具备语义能力，
      // 用它做向量排序会把无关片段排到前面，故此时退到词法召回。
      useFactory: (
        lexical: LexicalChunkRetriever,
        vector: EsVectorStore,
        embedding: EmbeddingProvider,
      ) => (embedding.productionReady ? vector : lexical),
      inject: [LexicalChunkRetriever, EsVectorStore, EMBEDDING_PROVIDER],
    },
  ],
  exports: [KbService, KbIndexer, CHUNK_RETRIEVER],
})
export class KbModule {}
