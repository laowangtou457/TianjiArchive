import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EsService } from '../../infra/elasticsearch/es.module';

/**
 * 片段检索索引（`kb_chunks`）—— `kb_entry` 的检索镜像。
 *
 * ## 为什么单独一个索引，而不是塞进 `archive_items`
 *
 * `archive_items` 的 `fulltext` 是 `store: false`（只索引不存），拿不到正文也就无法
 * 回吐片段；而片段级引用必须能返回原文。另建索引还能让"条目检索"与"片段检索"
 * 各自演化（片段要加向量字段，条目不需要）。
 *
 * ## 字段命名的硬约束
 *
 * `securityLevel` / `fondsId` / `orgId` / `createdBy` / `deleted` 必须与
 * `archive_items` **完全同名**——这样 `AccessFilterBuilder.buildEsFilter` 产出的
 * filter 子句可以原样复用，不需要第二套字段映射（字段名漂移是越权的高发区）。
 *
 * ## 已知边界
 *
 * `archive_item` 没有 `org_id` 列（机构归属实际在 `volume.org_id`），因此本索引的
 * `orgId` 恒为 null；ORG 型数据范围授权的用户检索不到片段。这与主检索**同源缺口**，
 * 已在《RAG知识库可行性评估》§2 单独登记，不在此处私修（否则会出现两套口径）。
 */

/** `kb_chunks` 索引内的一篇片段文档 */
export interface KbChunkEsDoc {
  /** 文档 ID 形如 `${itemId}:${chunkNo}`，天然幂等 */
  id: string;
  itemId: string;
  danghao: string;
  securityLevel: string;
  fondsId: string | null;
  orgId: string | null;
  createdBy: string | null;
  deleted: boolean;
  chunkNo: number;
  chunk: string;
}

/** ES 返回的片段命中 */
export interface KbChunkHit {
  itemId: string;
  danghao: string;
  securityLevel: string;
  chunkNo: number;
  chunk: string;
  score: number;
}

/** 内部分片文档结构（写入时不含 id） */
type KbChunkSource = Omit<KbChunkEsDoc, 'id'>;

@Injectable()
export class KbEsService implements OnModuleInit {
  private readonly logger = new Logger(KbEsService.name);
  public readonly index: string;

  public constructor(private readonly es: EsService) {
    this.index = process.env.ES_KB_INDEX ?? 'kb_chunks';
  }

  public async onModuleInit(): Promise<void> {
    try {
      await this.ensureIndex();
    } catch (err) {
      // ES 未就绪不阻塞启动：KB 检索降级为「无依据」，绝不返回编造内容
      this.logger.warn(`kb_chunks 索引初始化失败（KB 检索将不可用）: ${(err as Error).message}`);
    }
  }

  /** 索引是否就绪（供 /api/kb/status 与健康检查） */
  public async ready(): Promise<boolean> {
    try {
      return await this.es.client.indices.exists({ index: this.index });
    } catch {
      return false;
    }
  }

  /** 创建索引（幂等）。IK 缺失时降级 standard，保证索引可建、检索可用。 */
  public async ensureIndex(): Promise<void> {
    const exists = await this.es.client.indices.exists({ index: this.index });
    if (exists) {
      this.logger.log(`ES 片段索引已存在: ${this.index}`);
      return;
    }

    const ik = this.es.ikEnabled;
    if (!ik) this.logger.warn('未检测到 IK 分词，kb_chunks 使用 standard 分词降级（中文精度下降）');

    const indexAnalyzer = ik ? 'kb_ik_index' : 'kb_std_index';
    const searchAnalyzer = ik ? 'kb_ik_search' : 'kb_std_search';

    await this.es.client.indices.create({
      index: this.index,
      settings: {
        number_of_shards: 3,
        number_of_replicas: 1,
        analysis: {
          analyzer: {
            kb_ik_index: { type: 'custom', tokenizer: 'ik_max_word', filter: ['lowercase'] },
            kb_ik_search: { type: 'custom', tokenizer: 'ik_smart', filter: ['lowercase'] },
            kb_std_index: { type: 'custom', tokenizer: 'standard', filter: ['lowercase'] },
            kb_std_search: { type: 'custom', tokenizer: 'standard', filter: ['lowercase'] },
          },
        },
      },
      mappings: {
        // strict：字段名写错立刻报错，而不是悄悄建出一个永不命中的字段
        dynamic: 'strict',
        properties: {
          itemId: { type: 'keyword' },
          danghao: { type: 'keyword', ignore_above: 120 },
          securityLevel: { type: 'keyword' },
          fondsId: { type: 'keyword' },
          orgId: { type: 'keyword' },
          createdBy: { type: 'keyword' },
          deleted: { type: 'boolean' },
          chunkNo: { type: 'integer' },
          chunk: { type: 'text', analyzer: indexAnalyzer, search_analyzer: searchAnalyzer },
        },
      },
    });
    this.logger.log(`ES 片段索引创建成功: ${this.index}（IK=${ik}）`);
  }

  /** 全文检索（过滤子句由调用方给出，与主检索同一构造器） */
  public async search(
    question: string,
    filters: Array<Record<string, unknown>>,
    size: number,
  ): Promise<{ total: number; hits: KbChunkHit[] }> {
    const res = await this.es.client.search({
      index: this.index,
      body: {
        size,
        // 只取必要字段，避免把整篇片段正文重复搬运
        _source: ['itemId', 'danghao', 'securityLevel', 'chunkNo', 'chunk'],
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: question,
                  fields: ['chunk'],
                  type: 'best_fields',
                },
              },
            ],
            filter: filters,
          },
        },
        highlight: {
          pre_tags: ['<em class="hl">'],
          post_tags: ['</em>'],
          fields: { chunk: { fragment_size: 120, number_of_fragments: 1 } },
        },
      },
    });

    const body = res as unknown as {
      hits?: {
        total?: { value?: number } | number;
        hits?: Array<{
          _score?: number;
          _source?: KbChunkSource;
          highlight?: Record<string, string[]>;
        }>;
      };
    };
    const totalRaw = body.hits?.total;
    const total = typeof totalRaw === 'number' ? totalRaw : (totalRaw?.value ?? 0);

    const hits: KbChunkHit[] = (body.hits?.hits ?? []).flatMap((h) => {
      const src = h._source;
      if (!src) return [];
      const highlighted = h.highlight?.chunk?.[0];
      return [
        {
          itemId: src.itemId,
          danghao: src.danghao,
          securityLevel: src.securityLevel,
          chunkNo: src.chunkNo,
          chunk: highlighted ?? src.chunk,
          score: h._score ?? 0,
        },
      ];
    });

    return { total, hits };
  }

  /** 批量写入（幂等 upsert，_id = itemId:chunkNo） */
  public async bulkIndex(docs: KbChunkEsDoc[]): Promise<{ indexed: number; errors: number }> {
    if (docs.length === 0) return { indexed: 0, errors: 0 };
    const operations = docs.flatMap((d) => {
      const { id, ...source } = d;
      return [{ index: { _index: this.index, _id: id } }, source];
    });
    const res = await this.es.client.bulk({ operations, refresh: false });
    const items = (res as unknown as { items?: Array<Record<string, { error?: unknown }>> }).items ?? [];
    const errors = items.filter((it) => Object.values(it)[0]?.error).length;
    if (errors > 0) this.logger.warn(`kb_chunks 批量写入失败 ${errors}/${docs.length}`);
    return { indexed: docs.length - errors, errors };
  }

  /** 按条目删除全部片段（重建前的清理，或条目硬删时） */
  public async deleteByItem(itemId: string): Promise<number> {
    const res = await this.es.client.deleteByQuery({
      index: this.index,
      refresh: false,
      body: { query: { term: { itemId } } },
    });
    const deleted = (res as unknown as { deleted?: number }).deleted ?? 0;
    return deleted;
  }

  /** 某条目在索引中的片段数（重建后回读校验用） */
  public async countByItem(itemId: string): Promise<number> {
    const res = await this.es.client.count({
      index: this.index,
      body: { query: { term: { itemId } } },
    });
    return (res as unknown as { count?: number }).count ?? 0;
  }

  /** 刷新（重建脚本/测试用；生产由 ES 自身 refresh_interval 收敛） */
  public async refresh(): Promise<void> {
    try {
      await this.es.client.indices.refresh({ index: this.index });
    } catch {
      /* 忽略 */
    }
  }
}
