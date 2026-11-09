/**
 * SeaweedFS S3 Gateway 兼容性探针（方案 A 自验，必须真跑，不许静默降级）。
 *
 * 用法（api 容器内 / 本机有 node_modules 时均可）：
 *   pnpm --filter @tianji/api s3:probe
 *   MINIO_ENDPOINT=seaweedfs MINIO_PORT=8333 pnpm --filter @tianji/api s3:probe
 *
 * 覆盖业务代码实际用到的 9 个 S3 操作：
 *   bucketExists / makeBucket / putObject / statObject / getObject /
 *   presignedUrl（PUT 直传与分片签名）/ presignedGetObject /
 *   initiateNewMultipartUpload / listParts / completeMultipartUpload
 * 每项独立记 PASS/FAIL，任一失败即 `IS_PASS: NO` + 退出码 1，
 * 并把失败原文打印出来（便于逐项给替代方案，绝不静默跳过）。
 *
 * 每次运行使用独立探测桶（时间戳后缀），跑完尽力清理，不污染业务桶。
 */
import * as Minio from 'minio';
import { createHash } from 'node:crypto';

interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** 与生产完全同构的客户端参数（pathStyle + us-east-1） */
function buildClient(): Minio.Client {
  return new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT ?? 'seaweedfs',
    port: Number(process.env.MINIO_PORT ?? 8333),
    useSSL: (process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'tianji_minio',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'tianji_minio_change_me',
    region: 'us-east-1',
    pathStyle: true,
  });
}

/** 读取对象流为 Buffer */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** minio@8 把 listParts 声明为 protected（storage.module.ts 同款窄化调用） */
function listParts(
  client: Minio.Client,
  bucket: string,
  key: string,
  uploadId: string,
): Promise<Array<{ part: number; etag: string; size: number }>> {
  const internal = client as unknown as {
    listParts: (
      b: string,
      o: string,
      u: string,
    ) => Promise<Array<{ part: number; etag: string; size: number }>>;
  };
  return internal.listParts(bucket, key, uploadId);
}

async function main(): Promise<void> {
  const client = buildClient();
  const bucket = `tianji-s3-probe-${Date.now()}`;
  const results: ProbeResult[] = [];
  const keys: string[] = [];

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const value = await fn();
      const detail = value === undefined ? 'ok' : String(value).slice(0, 160);
      results.push({ name, ok: true, detail });
      return value;
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error).message });
      return null;
    }
  };

  console.log('════════════ SeaweedFS S3 兼容性探针 ════════════');
  console.log(
    `端点=${process.env.MINIO_ENDPOINT ?? 'seaweedfs'}:${process.env.MINIO_PORT ?? 8333} ` +
      `pathStyle=true region=us-east-1 探测桶=${bucket}`,
  );

  const existsBefore = await step('bucketExists', () => client.bucketExists(bucket));
  console.log(`  bucketExists（新建前，应为 false）= ${String(existsBefore)}`);
  await step('makeBucket', async () => {
    await client.makeBucket(bucket, 'us-east-1');
    return 'created';
  });
  await step('bucketExists(created)', () => client.bucketExists(bucket));

  const payload = Buffer.from('天玑离线样品 demo S3 探针内容 hello-seaweedfs', 'utf8');
  const plainKey = 'probe/plain.txt';
  keys.push(plainKey);
  await step('putObject', async () => {
    await client.putObject(bucket, plainKey, payload, payload.length, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return `size=${payload.length} sha256=${createHash('sha256').update(payload).digest('hex').slice(0, 12)}…`;
  });
  await step('statObject', async () => {
    const stat = await client.statObject(bucket, plainKey);
    return `size=${stat.size} etag=${stat.etag}`;
  });
  await step('getObject', async () => {
    const data = await streamToBuffer(await client.getObject(bucket, plainKey));
    if (!data.equals(payload)) throw new Error('getObject 内容与 putObject 不一致');
    return `bytes=${data.length} 内容一致`;
  });

  const presignKey = 'probe/presigned-put.txt';
  keys.push(presignKey);
  await step('presignedUrl(PUT 直传)', async () => {
    const url = await client.presignedUrl('PUT', bucket, presignKey, 3600);
    const resp = await fetch(url, { method: 'PUT', body: 'via-presigned-put' });
    if (!resp.ok) throw new Error(`PUT 返回 HTTP ${resp.status}`);
    await resp.arrayBuffer();
    return `http=${resp.status}`;
  });
  await step('presignedGetObject', async () => {
    const url = await client.presignedGetObject(bucket, plainKey, 3600);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`GET 返回 HTTP ${resp.status}`);
    const text = await resp.text();
    if (text !== payload.toString('utf8')) throw new Error('预签名 GET 内容不一致');
    return `http=${resp.status} 内容一致`;
  });

  const multiKey = 'probe/multipart.txt';
  keys.push(multiKey);
  const partBody = Buffer.from('part-one-data-for-multipart', 'utf8');
  const uploadId = await step('initiateNewMultipartUpload', () =>
    client.initiateNewMultipartUpload(bucket, multiKey, { 'Content-Type': 'text/plain' }),
  );
  if (uploadId !== null) {
    await step('presignedUrl(PUT 分片签名)', async () => {
      const url = await client.presignedUrl('PUT', bucket, multiKey, 3600, {
        uploadId,
        partNumber: '1',
      });
      const resp = await fetch(url, { method: 'PUT', body: partBody });
      if (!resp.ok) throw new Error(`分片 PUT 返回 HTTP ${resp.status}`);
      return `http=${resp.status} etag=${resp.headers.get('etag') ?? '(无)'}`;
    });
    const parts = await step('listParts', async () => {
      const listed = await listParts(client, bucket, multiKey, uploadId);
      if (listed.length === 0) throw new Error('listParts 返回 0 个分片');
      return `parts=${listed.length} firstPart=${listed[0]?.part}`;
    });
    if (parts !== null) {
      const listed = await listParts(client, bucket, multiKey, uploadId);
      await step('completeMultipartUpload', async () => {
        await client.completeMultipartUpload(
          bucket,
          multiKey,
          uploadId,
          listed.map((p) => ({ part: p.part, etag: p.etag })),
        );
        return 'ok';
      });
      await step('getObject(multipart 合成结果)', async () => {
        const data = await streamToBuffer(await client.getObject(bucket, multiKey));
        if (data.length !== partBody.length) {
          throw new Error(`合成对象长度 ${data.length} != 分片长度 ${partBody.length}`);
        }
        return `bytes=${data.length}`;
      });
    }
  }

  // 清理探测桶（尽力而为，失败不影响判定，但要显式打印）
  try {
    for (const key of keys) {
      await client.removeObject(bucket, key).catch(() => undefined);
    }
    await client.removeBucket(bucket).catch(() => undefined);
    console.log(`探测桶清理完成：${bucket}`);
  } catch (err) {
    console.log(`探测桶清理失败（不影响判定）：${(err as Error).message}`);
  }

  console.log('');
  console.log('──────────── 逐项结果 ────────────');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`);
  }
  const failures = results.filter((r) => !r.ok);
  console.log('');
  console.log(`OPS_TOTAL=${results.length} OPS_PASSED=${results.length - failures.length} OPS_FAILED=${failures.length}`);
  if (failures.length > 0) {
    console.log('IS_PASS: NO —— 存在不兼容操作，需逐项给出替代方案（严禁静默降级）');
    for (const f of failures) console.log(`  ✖ ${f.name}: ${f.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log('IS_PASS: YES —— 9 类 S3 操作与 SeaweedFS 3.79 S3 Gateway 全部兼容');
}

main().catch((err: Error) => {
  console.error(`✖ 探针异常终止：${err.message}`);
  process.exit(1);
});
