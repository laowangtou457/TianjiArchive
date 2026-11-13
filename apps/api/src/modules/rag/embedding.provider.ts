import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';

/**
 * 嵌入提供者接口（P4 三件套之一，架构预留点）。
 *
 * 为什么抽接口：档案系统的嵌入模型会换（本地 Ollama → 部门内网 embedding 服务 →
 * 商用 API），而 rag-service 的检索逻辑不该跟着变。换实现只改 providers 数组。
 *
 * 契约：
 *  - `embed` 返回与入参**等长**的向量数组，任一失败必须抛错（不允许返回零向量顶位，
 *    否则会污染向量库且极难排查）；
 *  - `dim` 必须与 `item_chunk.embedding` 列维度一致；
 *  - `health` 只做轻量探测（不发起真实推理），供 /api/rag/status 展示。
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
  health(): Promise<boolean>;
}

/**
 * Ollama 嵌入实现。
 *
 * 用 `/api/embed`（批量）而非旧的 `/api/embeddings`（单条）：
 * 重建 3000+ 条目的向量时，批量接口把 HTTP 往返降到 1/32，
 * 是「重建 41 秒 vs 十几分钟」的差别。
 */
@Injectable()
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'ollama';
  public readonly model: string;
  public readonly dim: number;
  private readonly logger = new Logger(OllamaEmbeddingProvider.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    const rag = config.get<AppConfig['rag']>('rag');
    this.baseUrl = (rag?.embeddingBaseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = rag?.embeddingModel ?? 'nomic-embed-text';
    this.dim = rag?.embeddingDim ?? 768;
    this.timeoutMs = rag?.embeddingTimeoutMs ?? 20000;
  }

  public async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`嵌入服务返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as { embeddings?: number[][] };
      const vectors = json.embeddings ?? [];
      if (vectors.length !== texts.length) {
        throw new Error(`嵌入数量不匹配：期望 ${texts.length}，实际 ${vectors.length}`);
      }
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== this.dim) {
          throw new Error(`向量维度不符：期望 ${this.dim}，实际 ${v?.length ?? 0}`);
        }
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }

  public async health(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (json.models ?? []).map((m) => m.name);
      // 只判断服务可达 + 模型存在；不做推理（推理探测会拖慢健康检查）
      return names.some((n) => n === this.model || n.startsWith(`${this.model}:`));
    } catch {
      return false;
    }
  }

  /** 把向量转成 pgvector 字面量 '[0.1,0.2,...]'（参数化传字符串最稳） */
  public static literal(vec: number[]): string {
    return `[${vec.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
  }
}

/**
 * 生成模型网关（LLM Gateway，P4 预留点之二）。
 *
 * 只暴露 `chat`，不暴露「提示词模板」：模板属于业务（RAG 摘要、Wiki 摘要、编研），
 * 网关只负责「把消息发出去、把文本收回来」，将来换模型/换厂商不影响业务提示词。
 */
@Injectable()
export class LlmGateway {
  private readonly logger = new Logger(LlmGateway.name);
  private readonly baseUrl: string;
  public readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    const rag = config.get<AppConfig['rag']>('rag');
    this.baseUrl = (rag?.llmBaseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = rag?.llmModel ?? 'qwen3:32b';
    this.timeoutMs = rag?.llmTimeoutMs ?? 60000;
  }

  public async available(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      return (json.models ?? []).some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );
    } catch {
      return false;
    }
  }

  /** 单轮对话；失败抛错，由调用方决定是否降级为抽取式摘要 */
  public async chat(system: string, user: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // qwen3 默认带思维链，回答会夹带 think 段落；档案问答要可读的结论
          options: { temperature: 0.2, num_ctx: 8192 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`生成服务返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as { message?: { content?: string } };
      return (json.message?.content ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
