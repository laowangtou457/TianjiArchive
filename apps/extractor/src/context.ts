import { DataSource } from 'typeorm';
import type IORedis from 'ioredis';
import { EsIndexer } from './es.indexer';
import { ObjectFetcher } from './object.fetcher';
import { ExtractProcessor } from './extract.processor';

/** 抽取器运行上下文（便于单测组装） */
export interface ExtractorContext {
  dataSource: DataSource;
  redis: IORedis;
  fetcher: ObjectFetcher;
  indexer: EsIndexer;
  processor: ExtractProcessor;
}

/** 各转换器对外统一产物 */
export interface ConvertOutput {
  /** 抽取的纯文本（用于全文检索与 PDF 文本预览） */
  text: string;
  /** 转换后的预览 PDF（Office 才有） */
  pdfBuffer?: Buffer | null;
  /** 缩略图 PNG（PDF/图片/视频首帧） */
  thumbBuffer?: Buffer | null;
  /** 是否支持（false 表示该类型可跳过，不计失败） */
  supported: boolean;
  /** 附加元信息（页数/时长/尺寸） */
  meta?: Record<string, unknown>;
}
