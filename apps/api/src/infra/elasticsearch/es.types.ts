/**
 * Elasticsearch 索引 mapping（架构 §7）。
 *
 * 字段策略：
 *  - title / responsible / keywords / fulltext：text + IK（ik_max_word 建索引，ik_smart 查询）；
 *  - fulltext 不存 _source（控体积），高亮改用 title/responsible 等可存字段；
 *  - danghao / fondsId / year / retention / securityLevel / categoryCode / docDate / status：
 *    keyword/date，兼做 filter 与 terms 分面（aggs）；
 *  - 分片 3、副本 1，refresh_interval=30s（批量写入性能优先）。
 */
export const ARCHIVE_INDEX_SETTINGS = {
  settings: {
    number_of_shards: 3,
    number_of_replicas: 1,
    refresh_interval: '30s',
    max_result_window: 20000,
    analysis: {
      analyzer: {
        // IK 优先；若插件缺失（降级环境）则回退 standard，保证索引可建
        ik_index_analyzer: {
          type: 'custom',
          tokenizer: 'ik_max_word',
          filter: ['lowercase'],
        },
        ik_search_analyzer: {
          type: 'custom',
          tokenizer: 'ik_smart',
          filter: ['lowercase'],
        },
        cn_fallback_index: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase'],
        },
        cn_fallback_search: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase'],
        },
        ngram_index: {
          type: 'custom',
          tokenizer: 'ngram_tokenizer',
          filter: ['lowercase'],
        },
      },
      tokenizer: {
        ngram_tokenizer: {
          type: 'ngram',
          min_gram: 2,
          max_gram: 3,
          token_chars: ['letter', 'digit'],
        },
      },
    },
  },
  mappings: {
    dynamic: 'strict' as const,
    properties: {
      id: { type: 'keyword' },
      danghao: { type: 'keyword' },
      title: {
        type: 'text',
        analyzer: 'ik_index_analyzer',
        search_analyzer: 'ik_search_analyzer',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
      responsible: {
        type: 'text',
        analyzer: 'ik_index_analyzer',
        search_analyzer: 'ik_search_analyzer',
        fields: { keyword: { type: 'keyword', ignore_above: 128 } },
      },
      docNo: { type: 'keyword', ignore_above: 128 },
      keywords: {
        type: 'text',
        analyzer: 'ik_index_analyzer',
        search_analyzer: 'ik_search_analyzer',
        fields: { keyword: { type: 'keyword', ignore_above: 128 } },
      },
      note: { type: 'text', analyzer: 'ik_index_analyzer', search_analyzer: 'ik_search_analyzer' },
      fulltext: {
        type: 'text',
        analyzer: 'ik_index_analyzer',
        search_analyzer: 'ik_search_analyzer',
        // 仅索引不存，控制索引体积
        index: true,
        store: false,
      },
      fondsId: { type: 'keyword' },
      orgId: { type: 'keyword' },
      volumeId: { type: 'keyword' },
      year: { type: 'integer' },
      retention: { type: 'keyword' },
      securityLevel: { type: 'keyword' },
      categoryCode: { type: 'keyword' },
      classNo: { type: 'keyword', ignore_above: 64 },
      status: { type: 'keyword' },
      openFlag: { type: 'keyword' },
      docDate: { type: 'date', format: 'yyyy-MM-dd||strict_date_optional_time||epoch_millis' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      createdBy: { type: 'keyword' },
      deleted: { type: 'boolean' },
      fileCount: { type: 'integer' },
      hasPreview: { type: 'boolean' },
    },
  },
} as const;

/** ES 侧文档结构（与 mapping 对应） */
export interface ArchiveEsDoc {
  id: string;
  danghao: string;
  title: string;
  responsible: string | null;
  docNo: string | null;
  keywords: string[];
  note: string | null;
  fulltext: string;
  fondsId: string;
  orgId: string | null;
  volumeId: string | null;
  year: number;
  retention: string;
  securityLevel: string;
  categoryCode: string | null;
  classNo: string | null;
  status: string;
  openFlag: string;
  docDate: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  deleted: boolean;
  fileCount: number;
  hasPreview: boolean;
}
