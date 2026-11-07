import { Logger } from '@nestjs/common';
import { Client as EsClient } from '@elastic/elasticsearch';

/**
 * ES 索引更新器（抽取器侧）。
 *
 * 职责：抽取完成后把正文写入 `archive_item.fulltext`，使全文检索可命中正文内容。
 * 若 ES 不可用则降级为仅日志（PG 侧 to_tsvector 索引仍可兜底检索）。
 */
export class EsIndexer {
  private readonly logger = new Logger(EsIndexer.name);
  private readonly client: EsClient;
  private readonly index: string;
  private available = true;

  public constructor() {
    this.client = new EsClient({
      node: process.env.ES_NODE ?? 'http://127.0.0.1:9200',
      auth: process.env.ES_USERNAME
        ? { username: process.env.ES_USERNAME, password: process.env.ES_PASSWORD ?? '' }
        : undefined,
      requestTimeout: 15000,
      maxRetries: 1,
    });
    this.index = process.env.ES_INDEX ?? 'archive_items';
  }

  /**
   * 更新条目正文（partial update，保留其它字段）。
   * @param itemId 条目 ID（ES 文档 _id 与 PG 主键一致）
   * @param text   抽取的正文（截断到 500KB，避免单文档过大）
   */
  public async updateFulltext(itemId: string, text: string): Promise<void> {
    if (!this.available) return;
    const fulltext = (text ?? '').slice(0, 500 * 1024);
    try {
      await this.client.update({
        index: this.index,
        id: itemId,
        doc: { fulltext, hasFulltext: fulltext.length > 0 },
        doc_as_upsert: false,
        retry_on_conflict: 2,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('document_missing_exception') || msg.includes('not_found')) {
        this.logger.debug(`ES 无该条目文档，跳过 fulltext 更新：${itemId}`);
        return;
      }
      this.logger.warn(`ES 更新 fulltext 失败（不影响主流程）：${msg}`);
      if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
        this.available = false;
      }
    }
  }

  /** 健康探测 */
  public async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }
}
