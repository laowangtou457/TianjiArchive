/**
 * R-1 双端点契约（SeaweedFS 方案 A，主理人正式裁定）。
 *
 * 背景：SigV4 预签名把 Host 纳入签名串。若用容器 DNS `seaweedfs` 签发，
 * 浏览器无法解析；生成后替换 host 又破坏签名。故 MinioService 拆成：
 *   - rawClient（内部端点，供所有服务端 S3 操作）；
 *   - presignClient（S3_PUBLIC_*，仅签发预签名 URL）。
 *
 * 本测试**不发任何网络请求**（显式 region + 静态凭据使 SDK 签发完全本地，
 * 已核 minio@8 dist/internal/client.js：getBucketRegionAsync 命中 this.region
 * 直接返回，checkAndRefreshCreds 无 credentialsProvider 时为空操作），
 * 仅断言「预签名 URL 的 host 来自 publicClient，且内部端点保持不变」。
 * 真实连通性/浏览器可达性由 docs/perf/runs/ 下的 s3:probe 与 presign 实测承接。
 */
import { describe, expect, it } from 'vitest';
import { URL } from 'node:url';
import { MinioService } from '@api/infra/storage/storage.module';
import { BUCKET } from '@tianji/shared';
import type { AppConfig } from '@api/config/configuration';

function fakeConfig(values: Record<string, unknown>) {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  };
}

/**
 * 与真实 configuration.ts 的 minio.buckets 形态一致（小写键）。
 * 值取自 @tianji/shared 的 BUCKET 常量，避免 fixture 与共享契约漂移。
 * 注意：BUCKET 本身是大写键常量，不能直接塞进 AppConfig['minio'].buckets
 * —— 那会让 MinioService 读 mc.buckets.original 得到 undefined 并回落到默认值，
 * 造成「假绿/假红」的 fixture 缺陷（本轮实测已捕获并修正）。
 */
const FAKE_BUCKETS: AppConfig['minio']['buckets'] = {
  original: BUCKET.ORIGINAL,
  preview: BUCKET.PREVIEW,
  thumb: BUCKET.THUMB,
  backup: BUCKET.BACKUP,
};

function makeConfig(overrides: Partial<AppConfig['minio']> = {}): AppConfig['minio'] {
  return {
    endPoint: 'seaweedfs',
    port: 8333,
    useSSL: false,
    accessKey: 'tianji_minio',
    secretKey: 'tianji_minio_change_me',
    buckets: FAKE_BUCKETS,
    presignExpires: 3600,
    publicEndPoint: '127.0.0.1',
    publicPort: 8333,
    publicUseSSL: false,
    ...overrides,
  };
}

function makeService(minio: AppConfig['minio']): MinioService {
  return new MinioService(fakeConfig({ minio }) as never);
}

describe('R-1 双端点：预签名 URL 使用浏览器可达端点', () => {
  it('rawClient 走内部容器端点，presignClient 走 S3_PUBLIC_* 且二者独立', () => {
    const svc = makeService(makeConfig());
    expect(svc.rawClient).toBeDefined();
    expect(svc.presignClient).toBeDefined();
    // 必须是两个不同的客户端实例，避免「改一个端点全变」的回归
    expect(svc.presignClient).not.toBe(svc.rawClient);
    // 内部端点是容器 DNS（SDK 把 endPoint 存到 host 字段）
    expect((svc.rawClient as unknown as { host: string }).host).toBe('seaweedfs');
    expect((svc.rawClient as unknown as { port: number }).port).toBe(8333);
    // 预签名客户端 host 是浏览器可达地址
    expect((svc.presignClient as unknown as { host: string }).host).toBe('127.0.0.1');
    expect((svc.presignClient as unknown as { port: number }).port).toBe(8333);
  });

  it('presignPut 生成的 URL host 为 publicEndPoint，Content-Type 以查询串进入签名', async () => {
    const svc = makeService(makeConfig());
    const url = await svc.presignPut('archive-original', 'demo/a.txt', 'text/plain');
    const parsed = new URL(url);
    expect(parsed.host).toBe('127.0.0.1:8333');
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    // 实测 minio@8：reqParams 里的 Content-Type 是「查询参数」而非签名头，
    // X-Amz-SignedHeaders=host；它仍进入 SigV4 canonical query，故浏览器 PUT
    // 携带任意 Content-Type 头都不破坏签名（真实 PUT 由 s3:probe 承接）。
    expect(parsed.searchParams.get('Content-Type')).toBe('text/plain');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('tianji_minio');
  });

  it('presignUploadPart 的 URL host 也是 publicEndPoint，且带 uploadId/partNumber', async () => {
    const svc = makeService(makeConfig());
    const url = await svc.presignUploadPart('archive-original', 'demo/a.txt', 'upload-xyz', 3);
    const parsed = new URL(url);
    expect(parsed.host).toBe('127.0.0.1:8333');
    expect(parsed.searchParams.get('uploadId')).toBe('upload-xyz');
    expect(parsed.searchParams.get('partNumber')).toBe('3');
  });

  it('presignGet 的 URL host 也是 publicEndPoint', async () => {
    const svc = makeService(makeConfig());
    const url = await svc.presignGet('archive-original', 'demo/a.txt');
    const parsed = new URL(url);
    expect(parsed.host).toBe('127.0.0.1:8333');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  it('封闭环境覆盖 S3_PUBLIC_* 为局域网 IP 时，三个预签名方法都签发到该 host', async () => {
    const svc = makeService(
      makeConfig({ publicEndPoint: '192.168.10.50', publicPort: 8333, publicUseSSL: false }),
    );
    const putUrl = new URL(await svc.presignPut('archive-original', 'k', 'application/octet-stream'));
    const partUrl = new URL(await svc.presignUploadPart('archive-original', 'k', 'u', 1));
    const getUrl = new URL(await svc.presignGet('archive-original', 'k'));
    expect(putUrl.host).toBe('192.168.10.50:8333');
    expect(partUrl.host).toBe('192.168.10.50:8333');
    expect(getUrl.host).toBe('192.168.10.50:8333');
    // 内部端点不受影响，仍是容器 DNS
    expect((svc.rawClient as unknown as { host: string }).host).toBe('seaweedfs');
  });

  it('publicUseSSL=true 时预签名 URL 为 https 且端口随 publicPort', async () => {
    const svc = makeService(
      makeConfig({ publicEndPoint: 's3.example.test', publicPort: 443, publicUseSSL: true }),
    );
    const url = new URL(await svc.presignGet('archive-original', 'k'));
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('s3.example.test');
  });

  it('桶名/预签名有效期等既有契约不受双端点影响', () => {
    const svc = makeService(makeConfig({ presignExpires: 900 }));
    expect(svc.presignExpires).toBe(900);
    expect(svc.buckets).toEqual(FAKE_BUCKETS);
    // 与 @tianji/shared 的架构 §11 桶名常量逐一对应（值不漂移）
    expect(Object.values(svc.buckets)).toEqual([
      BUCKET.ORIGINAL,
      BUCKET.PREVIEW,
      BUCKET.THUMB,
      BUCKET.BACKUP,
    ]);
  });
});
