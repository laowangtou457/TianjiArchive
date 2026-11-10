/**
 * 电子书链路的公共工具：ZIP 读取 / HTML 剥标签 / 文本解码。
 *
 * 刻意零依赖（不引 adm-zip / jszip）：
 *   - EPUB 是标准 ZIP，只需要「中央目录 + inflate」这一小片能力；
 *   - 抽取器运行在内网，新增依赖意味着新增供应链面，与工程"依赖最小化"口径一致；
 *   - 本文件自带单测夹具构造器（makeZip），测试与实现互为独立实现。
 */

import { inflateRawSync } from 'node:zlib';

/** 单条解压产物上限（与 document_text 的 5MB 口径对齐） */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** 整本正文上限（拼接后裁剪；document_text 还会做 5MB 兜底） */
export const MAX_BOOK_TEXT_CHARS = 5 * 1024 * 1024;

// ============================================================================
// 迷你 ZIP 读取（EPUB 容器）
// ============================================================================

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * 读取 ZIP 中央目录并解压全部条目。
 *
 * 支持 stored(0) / deflate(8)；不支持 ZIP64（单卷书不至于 >4GB，出现即显式报错）。
 * 用中央目录里的 size（而非本地头）——带 data descriptor（bit 3）的包本地头是 0。
 */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buffer);
  if (!eocd) throw new Error('不是有效的 ZIP/EPUB 容器（找不到中央目录结尾记录）');

  const entryCount = eocd.readUInt16LE(10);
  let ptr = eocd.readUInt32LE(16);

  const entries = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i += 1) {
    if (ptr + 46 > buffer.length || buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏（条目签名不符）');
    }
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`ZIP64 条目 ${name} 不支持（单文件超 4GB 上限）`);
    }
    if (entries.has(name)) continue;

    // 本地头：30 字节定长 + nameLen + extraLen（本地 extra 可能与中央目录不同）
    const lfh = localOffset;
    if (lfh + 30 > buffer.length || buffer.readUInt32LE(lfh) !== 0x04034b50) {
      throw new Error(`ZIP 本地头损坏（${name}）`);
    }
    const lNameLen = buffer.readUInt16LE(lfh + 26);
    const lExtraLen = buffer.readUInt16LE(lfh + 28);
    const dataStart = lfh + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } else {
      throw new Error(`ZIP 条目 ${name} 的压缩方法 ${method} 不支持（仅 stored/deflate）`);
    }
    entries.set(name, data);
  }
  return entries;
}

/** 从文件尾部向前找 EOCD（0x06054b50），容忍尾部注释 */
function findEocd(buffer: Buffer): Buffer | null {
  const minEocd = 22;
  const maxScan = Math.min(buffer.length, minEocd + 65536);
  for (let i = buffer.length - minEocd; i >= buffer.length - maxScan; i -= 1) {
    if (i < 0) return null;
    if (buffer.readUInt32LE(i) === 0x06054b50) return buffer.subarray(i, i + minEocd);
  }
  return null;
}

// ============================================================================
// HTML → 纯文本（EPUB 的 xhtml / MOBI 的 html 片段共用）
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
};

/** 解码命名与数字 HTML 实体（不含容错不了的奇怪写法，如实保留） */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML/XHTML → 纯文本（检索用，不做排版还原）：
 *   去注释与 script/style，块级结束标签与 <br> 折行，剥掉其余标签，解实体，
 *   压缩空白。这是"给检索看的正文"，不是"给读者看的排版"。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|table|dl|dd|dt|figcaption|header|footer|aside|main|nav|pre)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => decodeEntities(line).trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================================
// 纯文本解码（TXT；编码探测 fail-safe）
// ============================================================================

export interface DecodedText {
  readonly text: string;
  readonly charset: string;
}

/**
 * TXT 解码：BOM 显式优先 → UTF-8 严格探测 → GBK 回退 → latin1 兜底。
 *
 * 为什么不用 chardet 类库：中文 TXT 的现实分布就是 UTF-8 / GBK 两家，
 * "严格 UTF-8 解码失败"对 GBK 是高置信信号（GBK 双字节序列撞上合法
 * UTF-8 多字节序列的概率极低）；误判代价（个别生僻字乱码）远小于引入
 * 一个探测依赖的供应链成本。
 */
export function decodeTextFile(buffer: Buffer): DecodedText {
  // BOM 显式声明优先
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: stripBom(buffer.toString('utf8', 3)), charset: 'utf-8-sig' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: stripBom(new TextDecoder('utf-16le').decode(buffer.subarray(2))), charset: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: stripBom(new TextDecoder('utf-16be').decode(buffer.subarray(2))), charset: 'utf-16be' };
  }

  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    return { text: stripBom(strict.decode(buffer)), charset: 'utf-8' };
  } catch {
    // 不是合法 UTF-8 → 按 GBK 试；运行时无 gbk 表（精简 ICU）则 latin1 兜底
    try {
      return { text: new TextDecoder('gbk').decode(buffer), charset: 'gbk' };
    } catch {
      return { text: buffer.toString('latin1'), charset: 'latin1' };
    }
  }
}

/** 去掉解码后残留的 U+FEFF（零宽字符会污染分词） */
function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, '');
}
