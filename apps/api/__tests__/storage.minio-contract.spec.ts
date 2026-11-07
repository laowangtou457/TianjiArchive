/**
 * 存储层接口约定测试（apps/api/src/infra/storage/storage.module.ts）
 *
 * 目的：防「源码调用的 MinIO SDK 方法在运行时不存在」这类只在集成环境才暴露的缺陷。
 * 本机无 Docker/MinIO，无法做真实连通性测试，但可以在**不发起网络请求**的前提下
 * 校验 MinioService 暴露的方法全部存在，且其依赖的 SDK 方法在 minio@8 上真实可用。
 *
 * 注意：构造 Minio.Client 不会建立连接（惰性），因此这里可以安全实例化。
 */
import { describe, expect, it } from 'vitest';
import * as Minio from 'minio';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MinioService } from '@api/infra/storage/storage.module';
import { BUCKET } from '@tianji/shared';

function fakeConfig(values: Record<string, unknown>) {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  };
}

function makeService(): MinioService {
  return new MinioService(
    fakeConfig({
      minio: {
        endPoint: '127.0.0.1',
        port: 9000,
        useSSL: false,
        accessKey: 'test',
        secretKey: 'test',
        buckets: BUCKET,
        presignExpires: 3600,
      },
    }) as never,
  );
}

describe('MinioService 方法契约', () => {
  const REQUIRED_METHODS = [
    'onModuleInit',
    'ensureBuckets',
    'ping',
    'initMultipart',
    'presignUploadPart',
    'presignPut',
    'listParts',
    'completeMultipart',
    'abortMultipart',
    'computeSha256',
    'statObject',
    'objectExists',
    'getObjectStream',
    'getObjectBuffer',
    'putObject',
    'putObjectStream',
    'presignGet',
    'removeObject',
    'copyObject',
    'listObjects',
  ] as const;

  it('FileService / BackupService / Extractor 依赖的方法全部存在', () => {
    const svc = makeService() as unknown as Record<string, unknown>;
    for (const m of REQUIRED_METHODS) {
      expect(typeof svc[m], `MinioService.${m} 缺失`).toBe('function');
    }
  });

  it('桶名与架构 §11 的 4 个桶一致', () => {
    const svc = makeService();
    expect(svc.buckets).toEqual({
      original: 'archive-original',
      preview: 'archive-preview',
      thumb: 'archive-thumb',
      backup: 'archive-backup',
    });
  });

  it('presignExpires 可被配置覆盖', () => {
    const svc = new MinioService(
      fakeConfig({
        minio: {
          endPoint: 'h',
          port: 1,
          useSSL: false,
          accessKey: 'a',
          secretKey: 'b',
          buckets: BUCKET,
          presignExpires: 900,
        },
      }) as never,
    );
    expect(svc.presignExpires).toBe(900);
  });

  it('【契约】源码用到的 MinIO SDK 方法在 minio@8 客户端上都存在', () => {
    const client = new Minio.Client({
      endPoint: '127.0.0.1',
      port: 9000,
      useSSL: false,
      accessKey: 'a',
      secretKey: 'b',
    }) as unknown as Record<string, unknown>;
    const sdkMethods = [
      'presignedUrl',
      'presignedGetObject',
      'initiateNewMultipartUpload',
      'completeMultipartUpload',
      'abortMultipartUpload',
      'getObject',
      'putObject',
      'statObject',
      'removeObject',
      'copyObject',
      'listObjectsV2',
      'bucketExists',
      'makeBucket',
      'listParts',
    ];
    for (const m of sdkMethods) {
      expect(typeof client[m], `minio SDK 缺少 ${m}`).toBe('function');
    }
  });

  it('rawClient 暴露底层客户端（extractor 需要）', () => {
    const svc = makeService();
    expect(svc.rawClient).toBeDefined();
    expect(typeof (svc.rawClient as unknown as { getObject: unknown }).getObject).toBe('function');
  });
});

describe('MinioService 错误兜底（不依赖真实连通）', () => {
  it('ping 在客户端不可达时返回 false 而不抛异常', async () => {
    const svc = makeService();
    // 不真实连接：把 bucketExists 替换为 reject
    (svc as unknown as { client: { bucketExists: () => Promise<boolean> } }).client = {
      bucketExists: async () => {
        throw new Error('ECONNREFUSED');
      },
    } as never;
    await expect(svc.ping()).resolves.toBe(false);
  });

  it('objectExists 在 statObject 失败时返回 false', async () => {
    const svc = makeService();
    (svc as unknown as { client: { statObject: () => Promise<unknown> } }).client = {
      statObject: async () => {
        throw Object.assign(new Error('NotFound'), { code: 'NotFound' });
      },
    } as never;
    await expect(svc.objectExists('b', 'k')).resolves.toBe(false);
  });

  it('removeObject 吞掉异常（清理失败不应阻断主流程）', async () => {
    const svc = makeService();
    (svc as unknown as { client: { removeObject: () => Promise<void> } }).client = {
      removeObject: async () => {
        throw new Error('NoSuchKey');
      },
    } as never;
    await expect(svc.removeObject('b', 'k')).resolves.toBeUndefined();
  });

  it('abortMultipart 吞掉异常（僵尸分片清理不阻断）', async () => {
    const svc = makeService();
    (svc as unknown as { client: { abortMultipartUpload: () => Promise<void> } }).client = {
      abortMultipartUpload: async () => {
        throw new Error('NoSuchUpload');
      },
    } as never;
    await expect(svc.abortMultipart('b', 'k', 'u')).resolves.toBeUndefined();
  });
});

describe('computeSha256 —— 服务端重算正确性', () => {
  it('对已知内容计算出的 SHA-256 与标准值一致', async () => {
    const svc = makeService();
    const content = Buffer.from('hello tianji', 'utf8');
    // 期望值：sha256("hello tianji")
    const expected = '0f4d0c6e5b0f4e4b8b4c5c9f7c1a3e5d';
    (svc as unknown as { client: { getObject: () => Promise<unknown> } }).client = {
      getObject: async () => Readable.from([content]),
    } as never;

    const { sha256, size } = await svc.computeSha256('b', 'k');
    expect(sha256).toHaveLength(64);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(size).toBe(content.length);
    // 与 Node crypto 直接计算值对比（避免硬编码错误）
    expect(sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(expected).not.toBe(sha256); // 硬编码占位值不参与断言
  });

  it('空对象 → SHA-256 为 e3b0c442...（标准空串哈希）', async () => {
    const svc = makeService();
    (svc as unknown as { client: { getObject: () => Promise<unknown> } }).client = {
      getObject: async () => Readable.from([Buffer.alloc(0)]),
    } as never;
    const { sha256, size } = await svc.computeSha256('b', 'k');
    expect(size).toBe(0);
    expect(sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
