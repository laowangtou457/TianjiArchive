import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';

/** 桶名集合 */
export interface BucketNames {
  original: string;
  preview: string;
  thumb: string;
  backup: string;
}

/**
 * MinIO 对象存储服务。
 *
 * 能力：
 *  - 启动时确保 4 个桶存在（幂等）；
 *  - 分片上传预签名（S3 multipart，前端直传不过 API 流）；
 *  - 服务端重算 SHA-256 做完整性校验（四性-完整性）；
 *  - 预览/下载的短时效预签名 URL；
 *  - 流式读取与写入（供 extractor 与预览代理）。
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly client: Minio.Client;
  public readonly buckets: BucketNames;
  public readonly presignExpires: number;

  constructor(private readonly config: ConfigService) {
    const mc = config.get<AppConfig['minio']>('minio');
    this.client = new Minio.Client({
      endPoint: mc?.endPoint ?? '127.0.0.1',
      port: mc?.port ?? 9000,
      useSSL: mc?.useSSL ?? false,
      accessKey: mc?.accessKey ?? '',
      secretKey: mc?.secretKey ?? '',
      region: 'us-east-1',
      pathStyle: true,
    });
    this.buckets = {
      original: mc?.buckets.original ?? 'archive-original',
      preview: mc?.buckets.preview ?? 'archive-preview',
      thumb: mc?.buckets.thumb ?? 'archive-thumb',
      backup: mc?.buckets.backup ?? 'archive-backup',
    };
    this.presignExpires = mc?.presignExpires ?? 3600;
  }

  public async onModuleInit(): Promise<void> {
    try {
      await this.ensureBuckets();
    } catch (err) {
      this.logger.warn(`MinIO 桶初始化失败（文件功能将不可用）: ${(err as Error).message}`);
    }
  }

  /** 确保 4 个桶存在 */
  public async ensureBuckets(): Promise<void> {
    for (const name of Object.values(this.buckets)) {
      const exists = await this.client.bucketExists(name).catch(() => false);
      if (!exists) {
        await this.client.makeBucket(name, 'us-east-1');
        this.logger.log(`创建 MinIO 桶: ${name}`);
      }
    }
  }

  public async ping(): Promise<boolean> {
    try {
      return await this.client.bucketExists(this.buckets.original);
    } catch {
      return false;
    }
  }

  /** 原始客户端（extractor 等需要底层能力时） */
  public get rawClient(): Minio.Client {
    return this.client;
  }

  // ==========================================================================
  // 分片直传（NFR-6：单文件 ≤2GB，分片 5MB）
  // ==========================================================================

  /** 初始化分片上传，返回 uploadId */
  public async initMultipart(bucket: string, objectKey: string, mime: string): Promise<string> {
    return this.client.initiateNewMultipartUpload(bucket, objectKey, {
      'Content-Type': mime,
    });
  }

  /**
   * 生成分片上传的预签名 URL（前端 PUT 直传）。
   *
   * MinIO SDK 的 `presignedUrl(method, bucket, key, expires, reqParams)`
   * 中 `uploadId` / `partNumber` 必须作为查询参数进入签名的 reqParams，
   * 否则浏览器直传时服务端无法定位到具体分片。
   */
  public async presignUploadPart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return this.client.presignedUrl(
      'PUT',
      bucket,
      objectKey,
      this.presignExpires,
      { uploadId, partNumber: String(partNumber) },
    );
  }

  /** 生成整对象直传的预签名 URL（小文件，multipart=false） */
  public async presignPut(bucket: string, objectKey: string, mime: string): Promise<string> {
    return this.client.presignedUrl('PUT', bucket, objectKey, this.presignExpires, {
      'Content-Type': mime,
    });
  }

  /**
   * 列出已完成的分片。
   *
   * 说明：MinIO v8 的 `listParts` 声明为 protected（内部 API），但分片直传场景下
   * 必须用它来汇总 etag 才能完成合并。此处通过接口窄化调用，避免整体放宽类型。
   */
  public async listParts(
    bucket: string,
    objectKey: string,
    uploadId: string,
  ): Promise<Array<{ partNumber: number; etag: string; size: number }>> {
    const internal = this.client as unknown as {
      listParts: (
        b: string,
        o: string,
        u: string,
      ) => Promise<Array<{ part: number; etag: string; size: number }>>;
    };
    const uploaded = await internal.listParts(bucket, objectKey, uploadId);
    return uploaded
      .map((p) => ({ partNumber: p.part, etag: p.etag, size: p.size }))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  /** 完成分片上传 */
  public async completeMultipart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    await this.client.completeMultipartUpload(
      bucket,
      objectKey,
      uploadId,
      parts.map((p) => ({ part: p.partNumber, etag: p.etag })),
    );
  }

  /** 放弃分片上传（清理僵尸分片） */
  public async abortMultipart(bucket: string, objectKey: string, uploadId: string): Promise<void> {
    try {
      await this.client.abortMultipartUpload(bucket, objectKey, uploadId);
    } catch (err) {
      this.logger.warn(`放弃分片上传失败: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // 完整性 / 校验
  // ==========================================================================

  /** 读取对象并计算 SHA-256（服务端重算，用于与客户端比对） */
  public async computeSha256(bucket: string, objectKey: string): Promise<{ sha256: string; size: number }> {
    const stream = await this.client.getObject(bucket, objectKey);
    const hash = createHash('sha256');
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });
      stream.on('end', () => resolve());
      stream.on('error', (err: unknown) => reject(err as Error));
    });
    return { sha256: hash.digest('hex'), size };
  }

  /** 获取对象统计信息 */
  public async statObject(bucket: string, objectKey: string): Promise<{ size: number; etag: string; metaData: Record<string, string> }> {
    const stat = await this.client.statObject(bucket, objectKey);
    return {
      size: stat.size,
      etag: stat.etag,
      metaData: (stat.metaData ?? {}) as Record<string, string>,
    };
  }

  public async objectExists(bucket: string, objectKey: string): Promise<boolean> {
    try {
      await this.client.statObject(bucket, objectKey);
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // 读取 / 写入 / 预签名访问
  // ==========================================================================

  /** 流式读取对象 */
  public async getObjectStream(bucket: string, objectKey: string): Promise<NodeJS.ReadableStream> {
    return this.client.getObject(bucket, objectKey);
  }

  /** 读取对象全部内容（小文件，如缩略图） */
  public async getObjectBuffer(bucket: string, objectKey: string): Promise<Buffer> {
    const stream = await this.client.getObject(bucket, objectKey);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve());
      stream.on('error', (err: unknown) => reject(err as Error));
    });
    return Buffer.concat(chunks);
  }

  /** 写入对象（Buffer） */
  public async putObject(
    bucket: string,
    objectKey: string,
    data: Buffer | string,
    meta?: Record<string, string>,
  ): Promise<void> {
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await this.client.putObject(bucket, objectKey, body, body.length, meta);
  }

  /** 从流写入对象（分片上传由 SDK 内部处理） */
  public async putObjectStream(
    bucket: string,
    objectKey: string,
    stream: NodeJS.ReadableStream,
    size?: number,
    meta?: Record<string, string>,
  ): Promise<void> {
    // SDK 期望 Node 的 stream.Readable；此处从通用可读流窄化，
    // 调用方（extractor / cli-migrator）传入的均为 fs.ReadStream，运行时兼容。
    await this.client.putObject(
      bucket,
      objectKey,
      stream as unknown as import('node:stream').Readable,
      size,
      meta,
    );
  }

  /** 生成下载/预览的短时效预签名 URL */
  public async presignGet(
    bucket: string,
    objectKey: string,
    expiresSeconds?: number,
    responseHeaders?: Record<string, string | number>,
  ): Promise<string> {
    // SDK 的 respHeaders 只接受 string 值，数值型（如 content-length）需转字符串
    const headers: Record<string, string> | undefined = responseHeaders
      ? Object.fromEntries(
          Object.entries(responseHeaders).map(([k, v]) => [k, String(v)]),
        )
      : undefined;
    return this.client.presignedGetObject(
      bucket,
      objectKey,
      expiresSeconds ?? this.presignExpires,
      headers,
    );
  }

  /** 删除对象 */
  public async removeObject(bucket: string, objectKey: string): Promise<void> {
    try {
      await this.client.removeObject(bucket, objectKey);
    } catch (err) {
      this.logger.warn(`删除对象失败 ${bucket}/${objectKey}: ${(err as Error).message}`);
    }
  }

  /** 复制对象（用于备份到备份桶） */
  public async copyObject(
    sourceBucket: string,
    sourceKey: string,
    targetBucket: string,
    targetKey: string,
  ): Promise<void> {
    await this.client.copyObject(
      targetBucket,
      targetKey,
      `/${sourceBucket}/${sourceKey}`,
      undefined,
    );
  }

  /** 列出对象（备份/清理任务用） */
  public async listObjects(
    bucket: string,
    prefix?: string,
    maxKeys = 1000,
  ): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    const out: Array<{ key: string; size: number; lastModified: Date }> = [];
    const stream = this.client.listObjectsV2(bucket, prefix ?? '', true) as unknown as {
      on: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (obj: unknown) => {
        const o = obj as { name: string; size: number; lastModified: Date };
        out.push({ key: o.name, size: o.size, lastModified: o.lastModified });
        if (out.length >= maxKeys) resolve();
      });
      stream.on('end', () => resolve());
      stream.on('error', (err: unknown) => reject(err as Error));
    });
    return out;
  }
}

@Global()
@Module({
  providers: [MinioService],
  exports: [MinioService],
})
export class StorageModule {}
