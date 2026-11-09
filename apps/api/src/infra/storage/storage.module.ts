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
 * 对象存储服务（S3 兼容客户端）。
 *
 * 类名/文件名 `MinioService` 保留：应用侧用 minio npm SDK 走标准 S3 协议
 * （pathStyle:true / region us-east-1），**当前后端实现为 SeaweedFS S3 Gateway**
 * （方案 A，替代已归档停服的 MinIO 开源版）。MINIO_* 为 S3 兼容配置名，
 * 只要服务端实现 S3 语义，SDK 与配置名都不需要换。
 *
 * R-1 双端点（主理人正式裁定，除预签名端点外业务代码零改动）：
 *  - `client`（内部端点 MINIO_ENDPOINT=seaweedfs:8333）：桶操作、PUT/GET/HEAD、
 *    服务端 multipart 调用、删除/列举/复制等**所有**服务端操作；
 *  - `publicClient`（S3_PUBLIC_*）：**仅**用于签发预签名 URL（presignUploadPart /
 *    presignPut / presignGet）。因为 SigV4 签名把 Host 纳入签名串，`endPoint` 是
 *    容器 DNS 时浏览器无法解析；生成后再替换 host 又必然破坏签名。故从结构上
 *    解耦：浏览器直连宿主暴露的 8333（不经 nginx 反代，规避 X-Forwarded-* 依赖）。
 *  两端点共用同一 accessKey/secretKey/region/pathStyle，只覆盖 endPoint/port/useSSL，
 *  避免凭据漂移（架构规格 §1.2）。
 *
 * 能力：
 *  - 启动时确保 4 个桶存在（幂等，单点建桶；SeaweedFS 侧由 s3.json identity 收权）；
 *  - 分片上传预签名（S3 multipart，前端直传不过 API 流）；
 *  - 服务端重算 SHA-256 做完整性校验（四性-完整性）；
 *  - 预览/下载的短时效预签名 URL；
 *  - 流式读取与写入（供 extractor 与预览代理）。
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  /** 内部端点客户端：所有服务端 S3 操作（除预签名签发） */
  private readonly client: Minio.Client;
  /** R-1：仅签发预签名 URL 的浏览器可达端点客户端 */
  private readonly publicClient: Minio.Client;
  public readonly buckets: BucketNames;
  public readonly presignExpires: number;

  constructor(private readonly config: ConfigService) {
    const mc = config.get<AppConfig['minio']>('minio');
    const common = {
      accessKey: mc?.accessKey ?? '',
      secretKey: mc?.secretKey ?? '',
      region: 'us-east-1',
      pathStyle: true,
    } as const;
    this.client = new Minio.Client({
      ...common,
      endPoint: mc?.endPoint ?? '127.0.0.1',
      port: mc?.port ?? 8333,
      useSSL: mc?.useSSL ?? false,
    });
    // R-1：publicClient 只覆盖 endPoint/port/useSSL，凭据与寻址方式与内部客户端一致。
    this.publicClient = new Minio.Client({
      ...common,
      endPoint: mc?.publicEndPoint ?? '127.0.0.1',
      port: mc?.publicPort ?? 8333,
      useSSL: mc?.publicUseSSL ?? false,
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
      this.logger.warn(`对象存储桶初始化失败（文件功能将不可用）: ${(err as Error).message}`);
    }
  }

  /** 确保 4 个桶存在 */
  public async ensureBuckets(): Promise<void> {
    for (const name of Object.values(this.buckets)) {
      const exists = await this.client.bucketExists(name).catch(() => false);
      if (!exists) {
        await this.client.makeBucket(name, 'us-east-1');
        this.logger.log(`创建对象存储桶: ${name}`);
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

  /** 内部端点客户端（extractor 等需要底层能力时） */
  public get rawClient(): Minio.Client {
    return this.client;
  }

  /** R-1：浏览器可达端点客户端（仅用于预签名 URL 签发；供契约/探针核验） */
  public get presignClient(): Minio.Client {
    return this.publicClient;
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
   * R-1：必须用 `publicClient` 签发 —— SigV4 签名含 Host，URL 的 host 必须是
   * 浏览器可达的 S3_PUBLIC_ENDPOINT（宿主 8333），而非容器 DNS `seaweedfs`。
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
    return this.publicClient.presignedUrl(
      'PUT',
      bucket,
      objectKey,
      this.presignExpires,
      { uploadId, partNumber: String(partNumber) },
    );
  }

  /**
   * 生成整对象直传的预签名 URL（小文件，multipart=false）。
   * R-1：publicClient 签发，Content-Type 进入签名串（浏览器 PUT 需带同名头）。
   */
  public async presignPut(bucket: string, objectKey: string, mime: string): Promise<string> {
    return this.publicClient.presignedUrl('PUT', bucket, objectKey, this.presignExpires, {
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

  /**
   * 生成下载/预览的短时效预签名 URL。
   * R-1：publicClient 签发，浏览器直连宿主 8333 读取/下载。
   */
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
    return this.publicClient.presignedGetObject(
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
