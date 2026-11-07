import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KbEntry } from '../../infra/database/entities/kb-entry.entity';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { LocalHashEmbeddingProvider } from './embedding.provider';
import { EsVectorStore } from './vector.store';

/**
 * 知识库 / 智能问答（F-20 P2 预留，P0 仅落地契约）。
 *
 * 设计（架构 §5.6）：
 *   - 路由命名空间 `/api/kb/*` 已就位，前端可提前接入不会 404；
 *   - `EmbeddingProvider` / `VectorStore` 为接口，P0 提供可运行的本地哈希向量实现（用于接口联调与单测），
 *     P2 可替换为真实模型（bge-m3 / text-embedding-3）与 pgvector / ES kNN；
 *   - 检索前强制走 AccessFilterBuilder.buildKbFilter，保证密级与数据范围与主检索一致（硬性验收要点 3）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KbEntry])],
  controllers: [KbController],
  providers: [KbService, LocalHashEmbeddingProvider, EsVectorStore],
  exports: [KbService, LocalHashEmbeddingProvider, EsVectorStore],
})
export class KbModule {}
