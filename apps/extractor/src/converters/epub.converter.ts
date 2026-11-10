import { Logger } from '@nestjs/common';
import type { ConvertOutput } from '../context';
import { MAX_BOOK_TEXT_CHARS, htmlToText, readZipEntries } from './book.common';

/** EPUB 元数据（OPF 解析产物） */
interface EpubManifest {
  /** spine 顺序对应的文档路径 */
  readonly docs: string[];
  readonly title: string | null;
}

/**
 * EPUB 处理器（书籍入库：F-22 检索链路的正文来源）。
 *
 * EPUB = ZIP（container.xml → OPF → spine 顺序的 xhtml）。
 * 这里只做**检索用正文抽取**，不做排版渲染：
 *   - 在线预览走 NONE（下载-only）—— 排版还原是阅读器的事，
 *     档案系统要的是"搜得到、可溯源"，不是"好看"；
 *   - spine 顺序解析失败时退化为"容器内全部 html 按路径排序"，
 *     宁可顺序不完美，不让一本书的正文静默缺失。
 */
export class EpubConverter {
  private readonly logger = new Logger(EpubConverter.name);

  public async convert(buffer: Buffer, filename: string): Promise<ConvertOutput> {
    let entries: Map<string, Buffer>;
    try {
      entries = readZipEntries(buffer);
    } catch (err) {
      throw new Error(`EPUB 容器解析失败（${filename}）：${(err as Error).message}`);
    }

    const manifest = this.readManifest(entries);
    const parts: string[] = [];
    for (const docPath of manifest.docs) {
      const data = entries.get(docPath);
      if (!data) continue; // spine 引用了不存在的文件：跳过，不中断整本
      const html = data.toString('utf8');
      parts.push(htmlToText(html));
      if (parts.join('\n\n').length > MAX_BOOK_TEXT_CHARS) break;
    }

    const text = parts.join('\n\n').slice(0, MAX_BOOK_TEXT_CHARS).trim();
    this.logger.debug(
      `EPUB 抽取 ${filename}：spine ${manifest.docs.length} 章，正文 ${text.length} 字`,
    );

    return {
      text,
      pdfBuffer: null,
      thumbBuffer: null,
      supported: true,
      meta: { chapters: manifest.docs.length, title: manifest.title ?? undefined },
    };
  }

  /** 解析 container.xml → OPF → manifest+spine */
  private readManifest(entries: Map<string, Buffer>): EpubManifest {
    const container =
      entries.get('META-INF/container.xml') ??
      entries.get('META-INF/container.xml'.toLowerCase());
    let opfPath: string | null = null;
    if (container) {
      const m = /<rootfile[^>]*full-path\s*=\s*"([^"]+)"/i.exec(container.toString('utf8'));
      if (m) opfPath = m[1];
    }

    if (opfPath && entries.has(opfPath)) {
      const spine = this.parseOpf(entries, opfPath);
      if (spine.docs.length > 0) return spine;
    }

    // OPF 不可用：退化为全量 html 按路径排序（顺序可能不完美，正文不缺失）
    this.logger.warn('EPUB 的 OPF/spine 不可用，退化为容器内 HTML 全量抽取（按路径排序）');
    const docs = [...entries.keys()]
      .filter((n) => /\.(x?html|htm)$/i.test(n))
      .sort((a, b) => a.localeCompare(b));
    return { docs, title: null };
  }

  /** 解析 OPF：manifest id→href 映射 + spine 顺序 → 文档路径列表 */
  private parseOpf(entries: Map<string, Buffer>, opfPath: string): EpubManifest {
    const opf = entries.get(opfPath)?.toString('utf8') ?? '';
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifest = new Map<string, { href: string; mediaType: string }>();
    const itemRe = /<item\b[^>]*>/gi;
    for (const tag of opf.match(itemRe) ?? []) {
      const id = /\bid\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
      const href = /\bhref\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
      const mediaType = /\bmedia-type\s*=\s*"([^"]+)"/i.exec(tag)?.[1] ?? '';
      if (id && href) manifest.set(id, { href, mediaType });
    }

    const docs: string[] = [];
    const refRe = /<itemref\b[^>]*>/gi;
    for (const tag of opf.match(refRe) ?? []) {
      const idref = /\bidref\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
      if (!idref) continue;
      const item = manifest.get(idref);
      if (!item) continue;
      if (!/x?html|htm/i.test(item.mediaType) && !/\.(x?html|htm)$/i.test(item.href)) continue;
      docs.push(this.resolveHref(baseDir, item.href));
    }

    const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1]?.trim() ?? null;
    return { docs, title };
  }

  /** OPF 内相对路径 → ZIP 条目名（去 ./、解 URL 编码；ZIP 内不含 ./ 前缀） */
  private resolveHref(baseDir: string, href: string): string {
    let p = href;
    try {
      p = decodeURIComponent(href);
    } catch {
      // 编码残缺就按原样用，不打断整本抽取
    }
    return (baseDir + p).replace(/^\.\//, '');
  }
}
