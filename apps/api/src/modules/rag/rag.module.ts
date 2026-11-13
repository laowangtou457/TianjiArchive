import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RagController } from './rag.controller';
import { LlmGateway, OllamaEmbeddingProvider } from './embedding.provider';
import { RagService } from './rag.service';
import { RagScheduler } from './rag.scheduler';

/**
 * RAG 模块（P4）。
 *
 * 三个预留接口（架构 P4 三件套）在本模块落地：
 *   1) EmbeddingProvider —— embedding.provider.ts，可换实现；
 *   2) RagService.retrieve（带行级权限的召回）—— 全系统唯一的 RAG 检索入口；
 *   3) LlmGateway —— 生成网关，只做「发消息收文本」，提示词留在业务层。
 *
 * AccessFilterBuilder 由全局 AccessModule 提供，无需在此 import。
 */
@Module({
  imports: [ConfigModule],
  controllers: [RagController],
  providers: [OllamaEmbeddingProvider, LlmGateway, RagService, RagScheduler],
  exports: [RagService, LlmGateway, OllamaEmbeddingProvider],
})
export class RagModule {}
