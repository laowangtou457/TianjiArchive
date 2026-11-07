import { Logger } from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import type { Readable } from 'node:stream';
import { BUCKET } from '@tianji/shared';

/**
 * 对象存储访问器（抽取器侧，只读取原件 + 写预览/缩略图）。
 */
export class ObjectFetcher {
  private readonly logger = new Logger(ObjectFetcher.name);
  private readonly client: MinioClient;
  private readonly bucketOriginal: string;

  public constructor() {
    this.client = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT ?? '127.0.0.1',
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: (process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY ?? 'tianji_minio',
      secretKey: process.env.MINIO_SECRET_KEY ?? 'tianji_minio_secret',
    });
    this.bucketOriginal = process.env.MINIO_BUCKET_ORIGINAL ?? BUCKET.ORIGINAL;
  }

  /** 读取对象为 Buffer（抽取器处理的是单个文件，内存可控；>2GB 由上传约束兜底） */
  public async getBuffer(objectKey: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucketOriginal, objectKey);
    return this.streamToBuffer(stream);
  }

  /** 写入预览桶 */
  public async putPreview(objectKey: string, data: Buffer, contentType: string): Promise<void> {
    await this.put(BUCKET.PREVIEW, objectKey, data, contentType);
  }

  /** 写入缩略图桶 */
  public async putThumb(objectKey: string, data: Buffer, contentType = 'image/png'): Promise<void> {
    await this.put(BUCKET.THUMB, objectKey, data, contentType);
  }

  /** 通用写入 */
  private async put(
    bucket: string,
    objectKey: string,
    data: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.putObject(bucket, objectKey, data, data.length, {
      'Content-Type': contentType,
    });
    this.logger.debug(`已写入 ${bucket}/${objectKey}（${data.length} 字节）`);
  }

  /** 流 → Buffer */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
