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
        await this.saveDocumentText(itemId, fileId, text);
      } else {
        // 本次抽取正文为空时清掉该文件历史残留行（重抽取由有文字变无文字的场景），
        // 保证下方按条目聚合的 fulltext 不含过期内容。无残留行时为空操作。
        await this.dataSource.query(`DELETE FROM document_text WHERE file_id = $1`, [fileId]);
      }

      // 4) ES 正文更新：按条目聚合重建，而非单文件覆盖。
      //    修复（2026-11-09 离线 demo 实证）：同一条目多文件（如 TXT+PDF）时，
      //    旧逻辑各文件各自 updateFulltext，last-write-wins——后完成的文件会把
      //    先完成文件的正文整段覆盖（实证：PDF 后到，把含校验标记的 TXT 正文
      //    冲掉，综合检索漏检且命中数随调度波动 3~5/6）。document_text（PG）
      //    是正文唯一权威源，按条目聚合后整体回写：与文件完成顺序无关、幂等
      //    （重复抽取不叠加）、单文件重抽取后聚合自动修正。
      await this.rebuildItemFulltext(itemId);

      // 5) 文件状态与派生键
      // 列名以 InitSchema 为准：electronic_file 无 extract_meta 列，
      // document_text 无 char_count/meta/updated_at 列（详见 saveDocumentText 注释）。
      await this.dataSource.query(
        `UPDATE electronic_file
            SET extract_status = $2,
                extract_error = NULL,
                preview_key = COALESCE($3, preview_key),
                thumb_key = COALESCE($4, thumb_key)
          WHERE id = $1`,
        [fileId, ExtractStatus.OK, previewKey, thumbKey],
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

  /** 写入/更新 document_text（按 file_id + version=1 幂等）。
   *
   * 修复（2026-11-09 离线 demo 自验发现）：旧 SQL 写入 `char_count` / `meta` /
   * `updated_at` 三列并漏掉 NOT NULL 的 `item_id`，与 InitSchema 实际 DDL
   * （id/item_id/file_id/content/version/created_at）不符，真实 PG 上必然报错，
   * 抽取链路全挂。此处按 DDL 对齐；`meta` 不再入库（无列），调用方仅日志使用。 */
  private async saveDocumentText(
    itemId: string,
    fileId: string,
    content: string,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO document_text (item_id, file_id, version, content)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (file_id, version)
       DO UPDATE SET content = EXCLUDED.content,
                     item_id = EXCLUDED.item_id`,
      [itemId, fileId, content.slice(0, 5 * 1024 * 1024)],
    );
  }

  /** 按条目聚合 document_text 重建 ES fulltext。
   *
   * 多文件条目（如 TXT+PDF）不再互相覆盖：每次任一文件抽取完成后，
   * 从 document_text 取该条目全部正文按 file_id 稳定排序拼接，
   * 整体回写 ES。与文件完成顺序无关；重复执行幂等（整体替换，不叠加）。 */
  private async rebuildItemFulltext(itemId: string): Promise<void> {
    const rows = (await this.dataSource.query(
      `SELECT content FROM document_text WHERE item_id = $1 ORDER BY file_id`,
      [itemId],
    )) as Array<{ content: string }>;
    const fulltext = rows.map((r) => r.content ?? '').join('\n');
    await this.indexer.updateFulltext(itemId, fulltext);
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
