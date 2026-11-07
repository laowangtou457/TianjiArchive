import { Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConvertOutput } from '../context';

/**
 * Office 文档处理器（Word/Excel/PPT，含 OFD 可另行扩展）。
 *
 * 流程：
 *   1) 写临时文件 → `soffice --headless --convert-to pdf` 转 PDF（镜像已装 LibreOffice + 中文字体）；
 *   2) 从转换出的 PDF 抽文本（pdf-parse）；
 *   3) pdftoppm 渲染首页缩略图。
 *
 * 说明：LibreOffice 转换是重 CPU 操作，worker 并发上限 4 已限制峰值。
 */
export class OfficeConverter {
  private readonly logger = new Logger(OfficeConverter.name);
  /** 单文件转换超时（毫秒） */
  private readonly timeoutMs = Number(process.env.OFFICE_CONVERT_TIMEOUT_MS ?? 180000);

  public async convert(buffer: Buffer, filename: string): Promise<ConvertOutput> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tianji-office-'));
    const ext = path.extname(filename) || '.bin';
    const inputPath = path.join(workDir, `${randomUUID()}${ext}`);

    try {
      await fs.writeFile(inputPath, buffer);
      const outDir = await this.convertToPdf(inputPath, workDir);
      if (!outDir) {
        return { text: '', pdfBuffer: null, thumbBuffer: null, supported: true, meta: { converted: false } };
      }
      const pdfPath = path.join(workDir, outDir);
      const pdfBuffer = await fs.readFile(pdfPath);

      let text = '';
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string; numpages: number }>;
        const parsed = await pdfParse(pdfBuffer);
        text = (parsed.text ?? '').trim();
      } catch (err) {
        this.logger.warn(`Office 转 PDF 后抽文本失败：${(err as Error).message}`);
      }

      return {
        text,
        pdfBuffer,
        thumbBuffer: await this.renderThumb(pdfBuffer),
        supported: true,
        meta: { converted: true },
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 调用 soffice 转 PDF，返回输出文件名（相对 workDir）；失败返回 null */
  private convertToPdf(inputPath: string, outDir: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const args = [
        '--headless',
        '--norestore',
        '--invisible',
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        outDir,
        inputPath,
      ];
      let child;
      try {
        child = spawn(process.env.SOFFICE_BIN ?? 'soffice', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        this.logger.warn(`LibreOffice 不可用（跳过 Office→PDF）：${(err as Error).message}`);
        resolve(null);
        return;
      }

      const timer = setTimeout(() => {
        this.logger.warn(`Office 转换超时（${this.timeoutMs}ms），终止进程`);
        child.kill('SIGKILL');
        resolve(null);
      }, this.timeoutMs);

      let stderr = '';
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        this.logger.warn(`soffice 启动失败：${err.message}`);
        resolve(null);
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0) {
          this.logger.warn(`soffice 退出码 ${code}：${stderr.slice(0, 300)}`);
          resolve(null);
          return;
        }
        const base = path.basename(inputPath, path.extname(inputPath));
        resolve(`${base}.pdf`);
      });
    });
  }

  /** PDF 首页缩略图 */
  private async renderThumb(pdfBuffer: Buffer): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      const chunks: Buffer[] = [];
      let child;
      try {
        child = spawn('pdftoppm', ['-png', '-f', '1', '-l', '1', '-r', '72', '-scale-to', '480'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        resolve(null);
        return;
      }
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
      child.stdin.write(pdfBuffer);
      child.stdin.end();
    });
  }
}
