/**
 * API 侧预签名端点探针（阶段二放行实证 ② / 裁定 2 CORS wire 前置）。
 *
 * 用途：
 *  1) 从**被测服务路径** `MinioService` 实际签发预签名 URL 并打印其 host，
 *     证明 API 容器内的 `publicClient` 真的读到了 S3_PUBLIC_* 配置。
 *     这不是 QA 脚本自建 client、不是 storage.dual-endpoint.spec.ts 单测、
 *     也不是 seaweedfs-s3-probe.ts 里的独立 client —— 三者全绿都不能替代本证据。
 *  2) 输出**真实预签名 URL**，供宿主机用原生 HTTP 做 CORS wire 验证
 *     （OPTIONS 预检 + 真实 PUT，断言 ETag / Access-Control-Expose-Headers）。
 *
 * 真实链路：loadConfiguration() 读容器 process.env → 真实 ConfigService →
 * new MinioService(...) → presignPut / presignUploadPart / presignGet（publicClient）。
 * initMultipart 走内部端点 client，先在 SeaweedFS 建一次真实分片上传，
 * 使 presignUploadPart 拿到的 uploadId 是真实有效的（不是占位符）。
 *
 * 用法（api 容器内）：
 *   pnpm --filter @tianji/api presign:host
 * 清理（宿主侧 CORS wire 验证完成后，丢弃探针创建的分片上传）：
 *   PROBE_ABORT=1 PROBE_UPLOAD_ID=<id> pnpm --filter @tianji/api presign:host
 */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { URL } from 'node:url';
import { loadConfiguration } from '../config/configuration';
import { MinioService } from '../infra/storage/storage.module';

const MIME = 'application/octet-stream';
const PART_OBJECT_KEY = 'wire-probe/presign-part-probe.bin';
const PUT_OBJECT_KEY = 'wire-probe/presign-put-probe.txt';

async function main(): Promise<void> {
  const cfg = loadConfiguration();
  // 真实 ConfigService + 真实 loadConfiguration() 结果（读容器 process.env），
  // 注入真实 MinioService 构造函数：这就是被测服务的签发路径。
  const config = new ConfigService({ minio: cfg.minio });
  const svc = new MinioService(config);
  const bucket = cfg.minio.buckets.original;
  const expectedHost = `${cfg.minio.publicEndPoint}:${cfg.minio.publicPort}`;

  // 清理模式：宿主侧 CORS wire 验证完成后调用，避免遗留僵尸分片上传。
  if (process.env.PROBE_ABORT === '1') {
    const uploadId = process.env.PROBE_UPLOAD_ID ?? '';
    if (!uploadId) throw new Error('PROBE_ABORT=1 需要同时提供 PROBE_UPLOAD_ID');
    await svc.abortMultipart(bucket, PART_OBJECT_KEY, uploadId);
    console.log(`ABORTED_UPLOAD_ID=${uploadId}`);
    return;
  }

  const uploadId = await svc.initMultipart(bucket, PART_OBJECT_KEY, MIME);
  const partUrl = await svc.presignUploadPart(bucket, PART_OBJECT_KEY, uploadId, 1);
  const putUrl = await svc.presignPut(bucket, PUT_OBJECT_KEY, MIME);
  const getUrl = await svc.presignGet(bucket, PUT_OBJECT_KEY);

  const signed: Array<{ source: string; url: string }> = [
    { source: 'MinioService.presignUploadPart', url: partUrl },
    { source: 'MinioService.presignPut', url: putUrl },
    { source: 'MinioService.presignGet', url: getUrl },
  ];

  console.log('===== API MinioService 实际签发预签名 URL（被测服务路径）=====');
  console.log(`S3_PUBLIC_ENDPOINT_ENV=${process.env.S3_PUBLIC_ENDPOINT ?? '(unset)'}`);
  console.log(`S3_PUBLIC_PORT_ENV=${process.env.S3_PUBLIC_PORT ?? '(unset)'}`);
  console.log(`S3_PUBLIC_USE_SSL_ENV=${process.env.S3_PUBLIC_USE_SSL ?? '(unset)'}`);
  console.log(`CONFIG_PUBLIC_ENDPOINT=${cfg.minio.publicEndPoint}`);
  console.log(`CONFIG_PUBLIC_PORT=${cfg.minio.publicPort}`);
  console.log(`EXPECTED_PUBLIC_HOST=${expectedHost}`);
  console.log(`INTERNAL_ENDPOINT=${cfg.minio.endPoint}:${cfg.minio.port}`);

  let allMatch = true;
  for (const item of signed) {
    const host = new URL(item.url).host;
    const match = host === expectedHost;
    allMatch = allMatch && match;
    console.log(`URL_SOURCE=${item.source} PRESIGN_HOST=${host} HOST_MATCH=${match ? 'YES' : 'NO'}`);
  }

  console.log(`PRESIGN_PART_URL=${partUrl}`);
  console.log(`PRESIGN_PUT_URL=${putUrl}`);
  console.log(`PRESIGN_GET_URL=${getUrl}`);
  console.log(`UPLOAD_ID=${uploadId}`);
  console.log(
    `IS_PASS: ${allMatch ? 'YES' : 'NO'} —— 三个预签名方法均从 publicClient 签发到配置的 public host`,
  );
  if (!allMatch) process.exitCode = 1;
}

main().catch((err: Error) => {
  console.error(`✖ presign-host-probe 失败：${err.message}`);
  process.exit(1);
});
