import { Logger } from '@nestjs/common';
import type { ConvertOutput } from '../context';

/**
 * PDF 处理器。
 *
 * - 文本层：pdf-parse 抽取全文；
 * - 缩略图：优先 pdftoppm（poppler-utils，镜像已装），失败回退无缩略图（页面用 PDF 内嵌渲染）；
 * - PDF 本身即预览载体，无需转 PDF。
 */
export class PdfConverter {
  private readonly logger = new Logger(PdfConverter.name);

  public async convert(buffer: Buffer): Promise<ConvertOutput> {
    let text = '';
    let pages = 0;
    try {
      // 动态 require：pdf-parse 在无 PDF 内容时会抛错，需捕获降级
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string; numpages: number }>;
      const parsed = await pdfParse(buffer);
      text = (parsed.text ?? '').trim();
      pages = parsed.numpages ?? 0;
    } catch (err) {
      this.logger.warn(`PDF 文本层抽取失败（将仅保留原文件预览）：${(err as Error).message}`);
    }

    return {
      text,
      pdfBuffer: null,
      thumbBuffer: await this.renderThumb(buffer),
      supported: true,
      meta: { pages, hasTextLayer: text.length > 0 },
    };
  }

  /** 首屏 PNG 缩略图（pdftoppm，失败返回 null） */
  private async renderThumb(buffer: Buffer): Promise<Buffer | null> {
    const { spawn } = await import('node:child_process');
    return new Promise<Buffer | null>((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let child;
      try {
        child = spawn('pdftoppm', ['-png', '-f', '1', '-l', '1', '-r', '72', '-scale-to', '480'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        this.logger.debug(`pdftoppm 不可用：${(err as Error).message}`);
        resolve(null);
        return;
      }
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => errChunks.push(c));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          this.logger.debug(`pdftoppm 退出码 ${code}：${Buffer.concat(errChunks).toString().slice(0, 200)}`);
          resolve(null);
        }
      });
      child.stdin.write(buffer);
      child.stdin.end();
    });
  }
}
