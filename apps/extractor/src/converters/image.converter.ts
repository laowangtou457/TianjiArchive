import { Logger } from '@nestjs/common';
import type { ConvertOutput } from '../context';

/**
 * 图片处理器。
 *
 * - 缩略图：sharp 生成 480px 宽 PNG（保留比例）；
 * - 文本：图片无文本层，P0 不做 OCR（P2 可接 tesseract），text 返回空；
 * - 图片本身即预览载体。
 */
export class ImageConverter {
  private readonly logger = new Logger(ImageConverter.name);

  public async convert(buffer: Buffer, mime: string): Promise<ConvertOutput> {
    let thumb: Buffer | null = null;
    let meta: Record<string, unknown> = {};
    try {
      // 动态 require：sharp 为原生模块，避免类型强耦合
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sharp = require('sharp') as (input: Buffer) => {
        metadata: () => Promise<{ width?: number; height?: number; format?: string }>;
        resize: (opt: { width: number; withoutEnlargement: boolean }) => {
          png: () => { toBuffer: () => Promise<Buffer> };
        };
      };
      const img = sharp(buffer);
      const info = await img.metadata();
      meta = { width: info.width ?? 0, height: info.height ?? 0, format: info.format ?? '' };
      thumb = await img
        .resize({ width: 480, withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch (err) {
      this.logger.warn(`图片缩略图生成失败（保留原图预览）：${(err as Error).message}`);
    }

    return {
      text: '',
      pdfBuffer: null,
      thumbBuffer: thumb,
      supported: true,
      meta: { ...meta, mime },
    };
  }
}
