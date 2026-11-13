import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import type { AppConfig } from '../../config/configuration';
import { ARCHIVE_INDEX_SETTINGS, type ArchiveEsDoc } from './es.types';

/**
 * ES 服务：索引初始化（IK mapping）、文档写入/删除、健康检查。
 * 索引初始化可重复执行（幂等）：存在则跳过，不存在则创建；IK 缺失时自动降级 standard。
 */
@Injectable()
export class EsService implements OnModuleInit {
  private readonly logger = new Logger(EsService.name);
  public readonly index: string;
  public readonly client: Client;
  private ikAvailable = true;

  constructor(private readonly config: ConfigService) {
    const es = config.get<AppConfig['es']>('es');
    this.index = es?.index ?? 'archive_items';
    this.client = new Client({
      node: es?.node ?? 'http://127.0.0.1:9200',
      auth:
        es?.username && es.password ? { username: es.username, password: es.password } : undefined,
      requestTimeout: 15000,
      maxRetries: 3,
      sniffOnStart: false,
    });
  }

  public async onModuleInit(): Promise<void> {
    try {
      await this.ensureIndex();
    } catch (err) {
      // ES 未就绪不应阻塞 API 启动（检索功能降级为 PG）
      this.logger.warn(`ES 索引初始化失败（将降级为 PG 检索）: ${(err as Error).message}`);
    }
  }

  /** 索引是否存在 */
  public async indexExists(): Promise<boolean> {
    return this.client.indices.exists({ index: this.index });
  }

  /** 探测 IK 插件是否可用 */
  public async detectIk(): Promise<boolean> {
    try {
      const res = await this.client.indices.analyze({
        body: { analyzer: 'ik_max_word', text: '天玑档案管理系统' },
      });
      const tokens = (res as unknown as { tokens?: unknown[] }).tokens;
      return Array.isArray(tokens) && tokens.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 创建/更新索引（幂等，可重跑）。
   * IK 插件缺失时把 analyzer 替换为标准分词，保证索引可建、检索可用（精度下降）。
   */
  public async ensureIndex(): Promise<void> {
    this.ikAvailable = await this.detectIk();
    if (!this.ikAvailable) {
      this.logger.warn('未检测到 IK 分词插件，索引将使用 standard 分词降级方案');
    }

    const exists = await this.indexExists();
    if (exists) {
      this.logger.log(`ES 索引已存在: ${this.index}`);
      return;
    }

    const body = this.buildIndexBody();
    await this.client.indices.create({ index: this.index, ...body });
    this.logger.log(`ES 索引创建成功: ${this.index}（IK=${this.ikAvailable}）`);

    // 尝试写入索引模板，便于后续滚动索引
    try {
      await this.client.indices.putIndexTemplate({
        name: `${this.index}-template`,
        index_patterns: [`${this.index}*`],
        template: {
          settings: body.settings as Record<string, unknown>,
          mappings: body.mappings as Record<string, unknown>,
        },
      });
    } catch (err) {
      this.logger.warn(`索引模板写入失败（忽略）: ${(err as Error).message}`);
    }
  }

  private buildIndexBody(): { settings: unknown; mappings: unknown } {
    const source = JSON.parse(JSON.stringify(ARCHIVE_INDEX_SETTINGS)) as {
      settings: Record<string, unknown>;
      mappings: Record<string, unknown>;
    };
    if (!this.ikAvailable) {
      // 替换分析器为降级版本
      const settings = source.settings as {
        analysis: { analyzer: Record<string, { tokenizer: string }> };
      };
      if (settings?.analysis?.analyzer) {
        for (const key of Object.keys(settings.analysis.analyzer)) {
          const analyzer = settings.analysis.analyzer[key];
          if (analyzer.tokenizer === 'ik_max_word') analyzer.tokenizer = 'standard';
          if (analyzer.tokenizer === 'ik_smart') analyzer.tokenizer = 'standard';
        }
      }
      const mappings = source.mappings as {
        properties: Record<string, { analyzer?: string; search_analyzer?: string }>;
      };
      for (const prop of Object.values(mappings.properties)) {
        if (prop.analyzer === 'ik_index_analyzer') prop.analyzer = 'cn_fallback_index';
        if (prop.search_analyzer === 'ik_search_analyzer') prop.search_analyzer = 'cn_fallback_search';
      }
    }
    return { settings: source.settings, mappings: source.mappings };
  }

  /** 健康检查（供 /api/health） */
  public async ping(): Promise<boolean> {
    try {
      return await this.client.ping();
    } catch {
      return false;
    }
  }

  /** 单文档写入（索引） */
  public async indexDoc(doc: ArchiveEsDoc): Promise<void> {
    await this.client.index({ index: this.index, id: doc.id, document: doc, refresh: false });
  }

  /** 批量写入（500/批，架构 §7） */
  public async bulkIndex(docs: ArchiveEsDoc[]): Promise<{ indexed: number; errors: number }> {
    if (docs.length === 0) return { indexed: 0, errors: 0 };
    const operations = docs.flatMap((doc) => [
      { index: { _index: this.index, _id: doc.id } },
      doc,
    ]);
    const res = await this.client.bulk({ operations, refresh: false });
    const items = (res as unknown as { items?: Array<Record<string, { error?: unknown }>> }).items ?? [];
    const errors = items.filter((it) => Object.values(it)[0]?.error).length;
    if (res.errors) {
      this.logger.warn(`ES 批量写入存在失败: ${errors}/${docs.length}`);
    }
    return { indexed: docs.length - errors, errors };
  }

  /** 删除文档（软删除时更新 deleted 字段，不物理删除） */
  public async deleteDoc(id: string): Promise<void> {
    try {
      await this.client.delete({ index: this.index, id, refresh: false });
    } catch (err) {
      // 文档不存在属正常
      const status = (err as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (status !== 404) throw err;
    }
  }

  /** 手动刷新（测试与压测用） */
  public async refresh(): Promise<void> {
    try {
      await this.client.indices.refresh({ index: this.index });
    } catch {
      /* 忽略 */
    }
  }

  public get ikEnabled(): boolean {
    return this.ikAvailable;
  }
}
