import { Logger } from '@nestjs/common';
import type { ConvertOutput } from '../context';
import { MAX_BOOK_TEXT_CHARS, htmlToText } from './book.common';

/** PalmDOC 压缩类型 */
const COMPRESSION_NONE = 1;
const COMPRESSION_PALMDOC = 2;
const COMPRESSION_HUFF = 17480; // 0x4448 'HUFF'

/** MOBI 文本编码（textEncoding 字段取值） */
const ENCODING_UTF8 = 65001;
const ENCODING_CP1252 = 1252;

/**
 * MOBI 处理器（书籍入库：F-22 检索链路的正文来源）。
 *
 * MOBI = PalmDB 容器 + PalmDOC 压缩的 HTML 片段。支持：
 *   - 压缩 1（不压缩）与 2（PalmDOC LZ77）—— 绝大多数存量 mobi；
 *   - trailing extra bytes（extraDataFlags，MOBI 头 0xF2 处声明）按规范剥离；
 *   - 编码 65001(UTF-8) 与 1252(CP1252)。
 *
 * 显式不支持（fail-closed + 指路，不静默给空正文）：
 *   - HUFF/CDIC 压缩（0x4448，老 Amazon 官方转换器产物）—— 解压需要
 *     HUFF/CDIC 两张表，复杂度对"检索正文抽取"不成比例，建议转 EPUB/PDF；
 *   - DRM 加密（encryption != 0）—— 法律与技术双重不可行，明确报错。
 *
 * 在线预览走 NONE（下载-only），与 EPUB 同口径。
 */
export class MobiConverter {
  private readonly logger = new Logger(MobiConverter.name);

  public async convert(buffer: Buffer, filename: string): Promise<ConvertOutput> {
    if (buffer.length < 68 || buffer.toString('ascii', 60, 68) !== 'BOOKMOBI') {
      throw new Error(`不是有效的 MOBI 文件（${filename}）：偏移 60 处无 BOOKMOBI 签名`);
    }

    const recordOffsets = this.readRecordOffsets(buffer);
    const record0 = this.readRecord(buffer, recordOffsets, 0);
    // record0 开头即 PalmDOC 头（compression @0），无独立魔数；
    // 'BOOKMOBI' 是 PalmDB 的 type/creator（文件偏移 60），已在上面校验。
    if (record0.length < 16) {
      throw new Error(`MOBI 首记录损坏（${filename}）：不足 PalmDOC 头长度`);
    }

    const compression = record0.readUInt16BE(0);
    const textLength = record0.readUInt32BE(4);
    const textRecordCount = record0.readUInt16BE(8);
    const encryption = record0.readUInt16BE(12);

    if (encryption !== 0) {
      throw new Error(`MOBI 带 DRM 加密（${filename}），无法抽取正文——加密内容不属于本系统处理范围`);
    }
    if (compression === COMPRESSION_HUFF) {
      throw new Error(
        `MOBI 采用 HUFF/CDIC 压缩（${filename}），暂不支持；请转存为 EPUB/PDF 后入库`,
      );
    }
    if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_PALMDOC) {
      throw new Error(`MOBI 压缩类型 ${compression} 不支持（${filename}）`);
    }

    // MOBI 扩展头：编码与 trailing extra flags
    let encoding = ENCODING_CP1252;
    let extraFlags = 0;
    if (record0.length >= 16 + 4 && record0.toString('ascii', 16, 20) === 'MOBI') {
      const mobiHeaderLen = record0.readUInt32BE(20);
      encoding = record0.readUInt32BE(28) === ENCODING_UTF8 ? ENCODING_UTF8 : ENCODING_CP1252;
      // extraDataFlags 位于 record0 偏移 0xF2（MOBI 头长度 ≥ 0xE4 才有此字段）
      if (mobiHeaderLen >= 0xe4 && record0.length >= 0xf4) {
        extraFlags = record0.readUInt16BE(0xf2);
      }
    }

    const parts: Buffer[] = [];
    let total = 0;
    for (let i = 1; i <= textRecordCount && i < recordOffsets.length; i += 1) {
      let rec = this.readRecord(buffer, recordOffsets, i);
      rec = trimTrailingEntries(rec, extraFlags);
      const chunk =
        compression === COMPRESSION_PALMDOC ? palmDocDecompress(rec) : Buffer.from(rec);
      parts.push(chunk);
      total += chunk.length;
      if (total > MAX_BOOK_TEXT_CHARS) break;
    }

    const raw = Buffer.concat(parts).subarray(0, Math.min(total, textLength || total));
    // CP1252 是单字节编码：绝不能走"严格 UTF-8 探测→GBK 回退"（高位字节会被
    // 误判成 GBK 双字节），必须直取 latin1 映射（CP1252 与 latin1 仅 0x80-0x9F
    // 区间的控制字符不同，对正文抽取无影响）
    const decoded = encoding === ENCODING_UTF8 ? raw.toString('utf8') : raw.toString('latin1');
    const text = htmlToText(decoded).slice(0, MAX_BOOK_TEXT_CHARS);

    this.logger.debug(`MOBI 抽取 ${filename}：文本记录 ${textRecordCount} 段，正文 ${text.length} 字`);

    return {
      text,
      pdfBuffer: null,
      thumbBuffer: null,
      supported: true,
      meta: { encoding, compression, chapters: textRecordCount },
    };
  }

  /** PalmDB 记录偏移表：数量 @76，条目自 78 起每条 8 字节（offset u32 BE） */
  private readRecordOffsets(buffer: Buffer): number[] {
    const count = buffer.readUInt16BE(76);
    if (count <= 0) throw new Error('MOBI/PalmDB 无记录');
    const offsets: number[] = [];
    for (let i = 0; i < count; i += 1) {
      offsets.push(buffer.readUInt32BE(78 + i * 8));
    }
    return offsets;
  }

  /** 单条记录数据 = 该记录偏移到下一记录偏移之间（最后一条到文件尾） */
  private readRecord(buffer: Buffer, offsets: number[], index: number): Buffer {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    if (start >= buffer.length || end < start) throw new Error('MOBI/PalmDB 记录偏移越界');
    return buffer.subarray(start, Math.min(end, buffer.length));
  }
}

/**
 * PalmDOC LZ77 解压。
 * 0x00 字面量 / 1-0x08 后跟 b 个字面量 / 0x09-0x7f ASCII /
 * 0x80-0xbf 空格+字符 / 0xc0-0xff 回引（距离 11 位 + 长度 3 位）。
 */
export function palmDocDecompress(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    i += 1;
    if (b === 0) {
      out.push(0);
    } else if (b <= 8) {
      for (let j = 0; j < b && i < data.length; j += 1) {
        out.push(data[i]);
        i += 1;
      }
    } else if (b <= 0x7f) {
      out.push(b);
    } else if (b <= 0xbf) {
      const b2 = data[i] ?? 0;
      i += 1;
      const lz = ((b << 8) | b2) & 0x3fff;
      const distance = lz >> 3;
      const length = (lz & 0x07) + 3;
      for (let j = 0; j < length; j += 1) {
        const at = out.length - distance;
        out.push(at >= 0 ? out[at] : 0x20);
      }
    } else {
      out.push(0x20);
      out.push(b ^ 0x80);
    }
  }
  return Buffer.from(out);
}

/**
 * 剥离文本记录尾部的 trailing entries（extraDataFlags 声明）。
 * 算法与 KindleUnpack 同源：flags 位 1-3 表示附加 trailing entry 数，
 * 位 0 表示 multibyte overlap（再从尾部多剥 (v&0x3)+1 字节）。
 * 从记录尾部向前逐条读变长宽度（每字节低 7 位计长，遇高位 0 或计满 4 位停）。
 */
export function trimTrailingEntries(record: Buffer, flags: number): Buffer {
  if (flags === 0 || record.length === 0) return record;

  let extraCount = 0;
  for (let bit = 1; bit < 16; bit += 1) {
    if (flags & (1 << bit)) extraCount += 1;
  }

  let size = record.length;
  for (let n = 0; n < extraCount && size > 0; n += 1) {
    size -= sizeOfTrailingEntry(record, size);
  }
  if (flags & 1 && size > 0) {
    const v = record[size - 1];
    size -= (v & 0x03) + 1;
  }
  // 护栏：flags 声明与实际尾部不符时（如手工构造的样本、或编码判读偏差），
  // 变长扫描可能啃进正文。真实 trailing data 只占记录的零头，剥掉超过一半
  // 记录的"尾部"几乎必然是判读错误 —— 此时保留原记录，宁可多留乱码也不丢正文。
  if (size < Math.floor(record.length / 2)) return record;
  return record.subarray(0, Math.max(0, size));
}

/** 从 data[0..size) 尾部向前读一个变长 trailing entry 的宽度（变长编码最多 3 字节） */
function sizeOfTrailingEntry(data: Buffer, size: number): number {
  let bitpos = 0;
  let result = 0;
  // 每字节 7 位、上限 21 位 ⇒ 最多 3 个字节，循环上限即为 3。
  // 编码方向：字节低 7 位按 7 位/字节升权拼值；**bit7 置位的字节是终止字节**
  for (let guard = 0; guard < 3; guard += 1) {
    const v = data[size - 1];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    size -= 1;
    if ((v & 0x80) !== 0 || bitpos >= 21 || size <= 0) break;
  }
  return result;
}
