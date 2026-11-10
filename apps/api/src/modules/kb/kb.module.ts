import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { EMBEDDING_PROVIDER, LocalHashEmbeddingProvider } from './embedding.provider';
import { EsVectorStore, VECTOR_STORE } from './vector.store';

/**
 * 知识库 / 智能问答（P2 预留，当前只落契约与可运行实现）。
 *
 * 设计（架构 §5.6）：
 *   - 路由命名空间 `/api/kb/*` 已就位，前端可提前接入不会 404；
 *   - `EmbeddingProvider` / `VectorStore` 经**令牌注入**，P0 绑定本地哈希向量实现
 *     与 PG 存储；P2 换真实模型（bge 系）或 ES kNN 时只改本文件 wiring，
 *     调用方（KbService）无需改动 —— 这是把「换模型必须改代码」收敛成「改一处」；
 *   - 检索前强制走 AccessFilterBuilder，保证密级与数据范围与主检索一致（验收要点 3）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KbEntry])],
  controllers: [KbController],
  providers: [
    KbService,
    LocalHashEmbeddingProvider,
    EsVectorStore,
    { provide: EMBEDDING_PROVIDER, useExisting: LocalHashEmbeddingProvider },
    { provide: VECTOR_STORE, useExisting: EsVectorStore },
  ],
  exports: [KbService, EMBEDDING_PROVIDER, VECTOR_STORE],
})
export class KbModule {}
