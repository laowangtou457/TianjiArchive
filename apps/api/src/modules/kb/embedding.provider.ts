import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * 向量化提供方接口（F-20 P2 预留）。
 *
 * 约定：
 *   - 批量接口，输入为已抽取的纯文本片段，输出与输入等长的向量数组；
 *   - `dimension` 固定后不可变更（切换模型需重建索引并写入新命名空间）。
 */
export interface EmbeddingProvider {
  /** 提供方标识（日志与审计用） */
  readonly name: string;
  /** 向量维度 */
  readonly dimension: number;
  /** 是否可用于生产（P0 的本地实现返回 false，仅供联调） */
  readonly productionReady: boolean;
  /** 批量向量化 */
  embed(texts: string[]): Promise<number[][]>;
  /** 单条向量化（默认实现可复用 embed） */
  embedOne(text: string): Promise<number[]>;
}

/** 注入令牌 */
export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';

/**
 * 本地哈希向量化实现（P0 占位，可离线运行）。
 *
 * 原理：字符 n-gram 哈希到固定维度并做 L2 归一化——不具备语义能力，
 * 仅用于打通「入库 → 向量 → 召回 → 过滤 → 组装」链路与单测，
 * 真实语义能力请在 P2 通过 Configuring 切换到远端模型实现。
 */
@Injectable()
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'local-hash';
  public readonly dimension = 256;
  public readonly productionReady = false;
  private readonly logger = new Logger(LocalHashEmbeddingProvider.name);

  /** 批量向量化 */
  public async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.hashVector(t));
  }

  /** 单条向量化 */
  public async embedOne(text: string): Promise<number[]> {
    return this.hashVector(text);
  }

  /** 字符 2-gram 哈希 + L2 归一化 */
  private hashVector(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const normalized = (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.length === 0) return vec;

    for (let i = 0; i < normalized.length - 1; i += 1) {
      const gram = normalized.slice(i, i + 2);
      const h = createHash('sha1').update(gram).digest();
      const idx = ((h[0] << 8) | h[1]) % this.dimension;
      const sign = (h[2] & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }

    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }

  /** 启动提示 */
  public warnIfPlaceholder(): void {
    this.logger.warn('当前使用本地哈希向量化（无语义能力），仅用于接口联调；生产请配置真实 Embedding 模型');
  }
}
