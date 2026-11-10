/**
 * 中文感知文本切块（片段化）—— KB / RAG 的 chunk 生产者。
 *
 * 设计约束（来自工程裁定，改动前请先读）：
 *   - **纯函数**：不依赖数据库、日志、时钟，便于 API 与 extractor 共用同一实现，
 *     避免两套切块逻辑导致检索结果随调用方漂移；
 *   - **有界长度**：任一片段长度 ∈ (0, max]，不留超长片段（超长会超出模型上下文，
 *     也让相似度坍缩成"整篇文档的均值"）；
 *   - **句读优先**：优先在句末标点/段落处断开；找不到再硬切，且尽量不切断英文单词；
 *   - **有重叠**：相邻片段保留 overlap 字符上下文，避免答案正好落在切口上；
 *   - **位置稳定**：同一输入恒产出同一结果（无随机、无时间依赖），保证重复重建幂等。
 *
 * 不负责的事：密级、档号、条目归属——这些必须由调用方从条目元数据带出，
 * 绝不允许切块逻辑自己推断（否则越权来源就是切块器）。
 */

/** 单个片段 */
export interface TextChunk {
  /** 片段序号，自 0 起，按原文顺序 */
  chunkNo: number;
  /** 片段正文 */
  text: string;
  /** 字符数（按 JS 字符串长度计，中文 1 字记 1） */
  charLen: number;
}

/** 切块参数（默认值针对中文档案公文正文调优） */
export interface ChunkOptions {
  /** 目标长度：达到即考虑断开 */
  target?: number;
  /** 上限长度：任一片段不得超过 */
  max?: number;
  /** 下限长度：短于此不单独成片（除非已到文末） */
  min?: number;
  /** 相邻片段重叠字符数 */
  overlap?: number;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  target: 400,
  max: 500,
  min: 120,
  overlap: 50,
};

/** 句末标点（含中文全角与英文半角），可在此后断开 */
const SENTENCE_END = new Set(['。', '！', '？', '；', '…', '!', '?', ';', '\n']);

/** 判断是否为"词内字符"（切点落在两个此类字符之间视为切断单词/数字） */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[0-9A-Za-z]/.test(ch);
}

/**
 * 在 [from, to] 区间内从后向前找最靠后的句读位置（返回断点索引，断点字符归前片）。
 * 找不到返回 -1。
 */
function findSentenceBreak(text: string, from: number, to: number): number {
  for (let i = to; i >= from; i -= 1) {
    if (SENTENCE_END.has(text[i])) return i;
  }
  return -1;
}

/**
 * 在 [from, to] 区间内选一个尽量不切断英文单词的硬切点。
 * 落点若是 `abc|def` 这种词内位置，向前退到词首；退过了 from 就原样返回。
 */
function findHardCut(text: string, from: number, to: number): number {
  let cut = to;
  // 最多退 24 字符，避免长数字串/英文串被反复回退导致片段过短
  for (let guard = 0; guard < 24 && cut > from; guard += 1) {
    if (!(isWordChar(text[cut - 1]) && isWordChar(text[cut]))) return cut;
    cut -= 1;
  }
  return cut > from ? cut : to;
}

/** 规整空白：统一换行符、去掉行尾空格、压缩连续空行（保留段落分隔语义） */
export function normalizeText(input: string): string {
  return (input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 切块主函数。
 *
 * @param input 原始正文（可含换行；空白会被规整）
 * @param options 覆盖默认参数
 * @returns 按原文顺序排列的片段数组；空白输入返回空数组
 */
export function chunkText(input: string, options: ChunkOptions = {}): TextChunk[] {
  const opt = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const max = Math.max(1, Math.floor(opt.max));
  const target = Math.min(Math.max(1, Math.floor(opt.target)), max);
  const min = Math.min(Math.max(1, Math.floor(opt.min)), target);
  const overlap = Math.min(Math.max(0, Math.floor(opt.overlap)), Math.max(0, target - 1));

  const text = normalizeText(input);
  if (text.length === 0) return [];

  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.length - start;
    let end: number;

    if (remaining <= max) {
      // 剩余可一次装下：整段收尾
      end = text.length;
    } else {
      // 先看能否在 target 附近遇到句读；再退到 max 内找；都不行则硬切
      const upper = Math.min(start + max, text.length);
      const boundary = findSentenceBreak(text, start + Math.min(min, max - 1), upper);
      if (boundary >= 0) {
        end = boundary + 1;
      } else {
        const near = findSentenceBreak(
          text,
          start + Math.min(min, max - 1),
          Math.min(start + target, text.length),
        );
        end = near >= 0 ? near + 1 : findHardCut(text, start, upper);
      }
    }

    // 兜底：保证前进且不超上限（findHardCut 在极端输入下可能等于 start）
    if (end <= start) end = Math.min(start + max, text.length);

    const piece = text.slice(start, end);
    chunks.push({ chunkNo: chunks.length, text: piece, charLen: piece.length });

    if (end >= text.length) break;
    // 下一片回退 overlap 形成上下文重叠；至少前进 1 字符，防死循环
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
