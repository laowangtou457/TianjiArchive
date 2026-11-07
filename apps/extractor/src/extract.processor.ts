import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  ExtractStatus,
  resolvePreviewKind,
  type ExtractJobPayload,
} from '@tianji/shared';
import type { ExtractorContext, ConvertOutput } from './context';
import { AudioVideoConverter } from './converters/av.converter';
import { ImageConverter } from './converters/image.converter';
import { OfficeConverter } from './converters/office.converter';
import { PdfConverter } from './converters/pdf.converter';
import type { ObjectFetcher } from './object.fetcher';
import type { EsIndexer } from './es.indexer';

/** 处理结果 */
export interface ProcessResult {
  status: ExtractStatus;
  charCount: number;
  previewKey: string | null;
  thumbKey: string | null;
}

/**
 * 抽取处理器：单文件全流程。
 *
 * 步骤：
 *   1) 从 MinIO 读取原件；
 *   2) 按 MIME 路由到对应转换器（PDF / Office / Image / AV / Text）；
 *   3) 写 document_text（正文）、electronic_file（previewKey/thumbKey/extractStatus）；
 *   4) 同步 ES 的 fulltext。
 *
 * 幂等性：同一 fileId 重复执行会覆盖 document_text 同版本内容并保持唯一约束（file_id + version）。
 */
export class ExtractProcessor {
  private readonly logger = new Logger(ExtractProcessor.name);
  private readonly pdfConverter = new PdfConverter();
  private readonly officeConverter = new OfficeConverter();
  private readonly imageConverter = new ImageConverter();
  private readonly avConverter = new AudioVideoConverter();

  public constructor(
    private readonly dataSource: DataSource,
    private readonly fetcher: ObjectFetcher,
    private readonly indexer: EsIndexer,
  ) {}

  /** 处理单个文件 */
  public async process(payload: ExtractJobPayload): Promise<ProcessResult> {
    const { fileId, itemId, objectKey, mime, filename } = payload;

    await this.markStatus(fileId, ExtractStatus.RUNNING, null);

    try {
      const buffer = await this.fetcher.getBuffer(objectKey);
      const output = await this.route(buffer, filename, mime);
      if (!output.supported) {
        await this.markStatus(fileId, ExtractStatus.SKIPPED, null);
        return { status: ExtractStatus.SKIPPED, charCount: 0, previewKey: null, thumbKey: null };
      }

      // 1) 预览 PDF（Office 专有）
      let previewKey: string | null = null;
      if (output.pdfBuffer) {
        previewKey = `${itemId}/${fileId}.pdf`;
        await this.fetcher.putPreview(previewKey, output.pdfBuffer, 'application/pdf');
      }

      // 2) 缩略图
      let thumbKey: string | null = null;
      if (output.thumbBuffer) {
        thumbKey = `${itemId}/${fileId}.png`;
        await this.fetcher.putThumb(thumbKey, output.thumbBuffer, 'image/png');
      }

      // 3) 正文入库
      const text = output.text ?? '';
      if (text.length > 0) {
        await this.saveDocumentText(fileId, text, output.meta ?? {});
      }

      // 4) ES 正文更新
      if (text.length > 0) {
        await this.indexer.updateFulltext(itemId, text);
      }

      // 5) 文件状态与派生键
      await this.dataSource.query(
        `UPDATE electronic_file
            SET extract_status = $2,
                extract_error = NULL,
                preview_key = COALESCE($3, preview_key),
                thumb_key = COALESCE($4, thumb_key),
                extract_meta = $5::jsonb
          WHERE id = $1`,
        [fileId, ExtractStatus.OK, previewKey, thumbKey, JSON.stringify(output.meta ?? {})],
      );

      return {
        status: ExtractStatus.OK,
        charCount: text.length,
        previewKey,
        thumbKey,
      };
    } catch (err) {
      const message = (err as Error).message ?? '未知错误';
      this.logger.error(`抽取失败 file=${fileId}: ${message}`);
      await this.markStatus(fileId, ExtractStatus.FAILED, message.slice(0, 500));
      throw err;
    }
  }

  /** 按 MIME 路由 */
  private async route(buffer: Buffer, filename: string, mime: string): Promise<ConvertOutput> {
    const kind = resolvePreviewKind(mime);

    if (kind === 'PDF' || mime === 'application/ofd') {
      // OFD 暂按 ZIP 容器处理，不做 PDF 解析（P1 可接 ofd 专用库）
      if (mime === 'application/ofd') {
        return { text: '', pdfBuffer: null, thumbBuffer: null, supported: true, meta: { ofd: true } };
      }
      return this.pdfConverter.convert(buffer);
    }

    if (kind === 'OFFICE') {
      return this.officeConverter.convert(buffer, filename);
    }

    if (kind === 'IMAGE') {
      return this.imageConverter.convert(buffer, mime);
    }

    if (kind === 'AUDIO' || kind === 'VIDEO') {
      return this.avConverter.convert(buffer, filename, mime);
    }

    if (kind === 'TEXT') {
      const text = buffer.toString('utf8');
      return { text, pdfBuffer: null, thumbBuffer: null, supported: true, meta: { chars: text.length } };
    }

    // 其它类型：可跳过（不计失败）
    return { text: '', pdfBuffer: null, thumbBuffer: null, supported: false, meta: { mime } };
  }

  /** 写入/更新 document_text（按 file_id + version=1 幂等） */
  private async saveDocumentText(
    fileId: string,
    content: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const charCount = content.length;
    await this.dataSource.query(
      `INSERT INTO document_text (file_id, version, content, char_count, meta)
       VALUES ($1, 1, $2, $3, $4::jsonb)
       ON CONFLICT (file_id, version)
       DO UPDATE SET content = EXCLUDED.content,
                     char_count = EXCLUDED.char_count,
                     meta = EXCLUDED.meta,
                     updated_at = now()`,
      [fileId, content.slice(0, 5 * 1024 * 1024), charCount, JSON.stringify(meta)],
    );
  }

  /** 更新抽取状态 */
  private async markStatus(fileId: string, status: ExtractStatus, error: string | null): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE electronic_file SET extract_status = $2, extract_error = $3 WHERE id = $1`,
        [fileId, status, error],
      );
    } catch (err) {
      this.logger.warn(`更新抽取状态失败 file=${fileId}: ${(err as Error).message}`);
    }
  }
}

/** 组装上下文（供单测使用） */
export function buildContext(
  dataSource: DataSource,
  fetcher: ObjectFetcher,
  indexer: EsIndexer,
): Pick<ExtractorContext, 'dataSource' | 'fetcher' | 'indexer'> {
  return { dataSource, fetcher, indexer };
}
