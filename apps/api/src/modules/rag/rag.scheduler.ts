import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { AppConfig } from '../../config/configuration';
import { RagService } from './rag.service';

/**
 * 向量建库增量任务（每 3 分钟，一批）。
 *
 * 为什么用小批次慢速推进而不是一次性全量：
 *  - 全量建库会长时间占满 CPU 与嵌入服务，影响在线检索；
 *  - 档案是「慢慢长出来的」，新增件不多，小步增量足以及时消化；
 *  - 真正需要立即建库时用 `POST /api/rag/reindex` 手动指定条目。
 *
 * 关闭开关：RAG_AUTO_INDEX=false。
 */
@Injectable()
export class RagScheduler {
  private readonly logger = new Logger(RagScheduler.name);
  private readonly enabled: boolean;
  private readonly batch: number;
  private running = false;

  constructor(
    private readonly ragService: RagService,
    config: ConfigService,
  ) {
    const rag = config.get<AppConfig['rag']>('rag');
    this.enabled = rag?.autoIndex ?? true;
    this.batch = rag?.autoIndexBatch ?? 20;
  }

  @Cron('0 */3 * * * *', { name: 'rag-incremental-index' })
  public async incremental(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const res = await this.ragService.reindex({ limit: this.batch });
      if (res.chunks > 0) {
        this.logger.log(`增量建库：${res.items} 件 / ${res.chunks} 块`);
      }
    } catch (err) {
      this.logger.error(`增量建库失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
