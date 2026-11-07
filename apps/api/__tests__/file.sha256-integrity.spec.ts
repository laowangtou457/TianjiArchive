/**
 * 电子文件 SHA-256 完整性校验单元测试（apps/api/src/modules/file/file.service.ts）
 *
 * 验收要点（架构 §6.2 / DA/T 58-2014）：
 *  ① complete 阶段服务端重算 SHA-256 与客户端比对；
 *  ② 不一致 → 抛 FILE_HASH_MISMATCH(4001) 且**必须清理已上传的脏对象**；
 *  ③ 不一致时不得落库（electronic_file 不得出现记录）；
 *  ④ 魔数不符也拒绝入库并清理；
 *  ⑤ 2GB 边界、非法 mime、不存在条目等错误路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { FileService } from '@api/modules/file/file.service';
import {
  CHUNK_SIZE,
  ExtractStatus,
  MAX_FILE_SIZE,
  SecurityLevel,
  type CompleteUploadRequest,
  type PermissionSnapshot,
  type PresignRequest,
} from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
function user(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    userId: 'u-1',
    username: 'u1',
    displayName: '用户1',
    roles: ['R1'],
    grants: {},
    maxSecurityLevel: SecurityLevel.SECRET,
    scopes: [],
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    ...over,
  };
}

const PDF_BYTES = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'binary');

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface MinioMock {
  buckets: { original: string; preview: string; thumb: string; backup: string };
  presignExpires: number;
  presignPut: ReturnType<typeof vi.fn>;
  initMultipart: ReturnType<typeof vi.fn>;
  presignUploadPart: ReturnType<typeof vi.fn>;
  completeMultipart: ReturnType<typeof vi.fn>;
  objectExists: ReturnType<typeof vi.fn>;
  computeSha256: ReturnType<typeof vi.fn>;
  removeObject: ReturnType<typeof vi.fn>;
  getObjectStream: ReturnType<typeof vi.fn>;
  presignGet: ReturnType<typeof vi.fn>;
  putObject: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { objectBytes?: Buffer } = {}) {
  const bytes = opts.objectBytes ?? PDF_BYTES;
  const removed: Array<{ bucket: string; key: string }> = [];
  const saved: Array<Record<string, unknown>> = [];
  const queueAdds: Array<Record<string, unknown>> = [];

  const minio: MinioMock = {
    buckets: {
      original: 'archive-original',
      preview: 'archive-preview',
      thumb: 'archive-thumb',
      backup: 'archive-backup',
    },
    presignExpires: 3600,
    presignPut: vi.fn(async () => 'https://minio.local/put'),
    initMultipart: vi.fn(async () => 'upload-1'),
    presignUploadPart: vi.fn(async (_b: string, _k: string, _u: string, n: number) => `https://minio.local/part/${n}`),
    completeMultipart: vi.fn(async () => undefined),
    objectExists: vi.fn(async () => true),
    computeSha256: vi.fn(async () => ({ sha256: sha256Of(bytes), size: bytes.length })),
    removeObject: vi.fn(async (bucket: string, key: string) => {
      removed.push({ bucket, key });
    }),
    getObjectStream: vi.fn(async () => Readable.from([bytes])),
    presignGet: vi.fn(async () => 'https://minio.local/get'),
    putObject: vi.fn(async () => undefined),
  };

  const itemRepo = {
    findOne: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === 'i-1'
        ? {
            id: 'i-1',
            danghao: 'A036-2024-BGS-Y-0001-0001',
            fondsId: 'f-1',
            securityLevel: SecurityLevel.PUBLIC,
            createdBy: 'u-1',
            deleted: false,
            fullText: null,
          }
        : null,
    ),
  };

  const fileRepo = {
    create: vi.fn((v: Record<string, unknown>) => v),
    save: vi.fn(async (v: Record<string, unknown>) => {
      // created_at 由实体 @CreateDateColumn / 数据库 DEFAULT 填充
      const withId = { id: `file-${saved.length + 1}`, createdAt: new Date(), ...v };
      saved.push(withId);
      return withId;
    }),
    findOne: vi.fn(async () => null),
    update: vi.fn(async () => ({ affected: 1 })),
    delete: vi.fn(async () => ({ affected: 1 })),
    find: vi.fn(async () => []),
  };

  const textRepo = { findOne: vi.fn(async () => null), find: vi.fn(async () => []) };

  const extractQueue = {
    add: vi.fn(async (name: string, payload: Record<string, unknown>) => {
      queueAdds.push({ name, ...payload });
      return { id: 'job-1' };
    }),
  };

  const accessBuilder = {
    canAccessRecord: vi.fn(() => true),
  };

  // DictService：下载/水印策略的唯一取数入口。
  // v1.3 起 file.service 通过 dict.getDownloadMode() 判定，不再直接读 isDownloadEnabled。
  const dict = {
    isWatermarkEnabled: vi.fn(async () => true),
    isDownloadEnabled: vi.fn(async () => false),
    getDownloadMode: vi.fn(async () => 'disabled' as 'disabled' | 'approval' | 'free'),
    getWatermarkTemplate: vi.fn(async () => '天玑档案'),
  };

  // ParamService：抽取队列等非策略参数取数（本文件不重点覆盖，给可用兜底即可）
  const paramService = {
    get: vi.fn(async () => null),
    getInt: vi.fn(async () => 0),
    getEnum: vi.fn(async () => null),
    getBool: vi.fn(async () => false),
  };

  const service = new FileService(
    fileRepo as never,
    itemRepo as never,
    textRepo as never,
    minio as never,
    dict as never,
    accessBuilder as never,
    paramService as never,
    extractQueue as never,
  );

  return {
    service,
    minio,
    fileRepo,
    itemRepo,
    textRepo,
    extractQueue,
    removed,
    saved,
    queueAdds,
    dict,
    paramService,
    accessBuilder,
  };
}

function completeDto(over: Partial<CompleteUploadRequest> = {}): CompleteUploadRequest {
  return {
    itemId: 'i-1',
    bucket: 'archive-original',
    objectKey: 'origin/2024/01/01/A036-2024-BGS-Y-0001-0001/abc.pdf',
    filename: '报告.pdf',
    mime: 'application/pdf',
    size: PDF_BYTES.length,
    sha256: sha256Of(PDF_BYTES),
    ...over,
  } as CompleteUploadRequest;
}

// ============================================================================
describe('presign —— 上传前校验', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  const base: PresignRequest = {
    itemId: 'i-1',
    filename: '报告.pdf',
    mime: 'application/pdf',
    size: 1024,
  } as PresignRequest;

  it('正常签发上传凭证', async () => {
    const r = await h.service.presign(base, user());
    expect(r.bucket).toBe('archive-original');
    expect(r.objectKey).toContain('origin/');
    expect(r.objectKey).toContain('A036-2024-BGS-Y-0001-0001');
  });

  it('空文件名 → 1001', async () => {
    await expect(h.service.presign({ ...base, filename: '  ' }, user())).rejects.toMatchObject({
      code: 1001,
    });
  });

  it('size=0 → 4003（非法大小按超限处理）', async () => {
    await expect(h.service.presign({ ...base, size: 0 }, user())).rejects.toMatchObject({
      code: 4003,
    });
  });

  it('【边界】恰好 2GB → 允许（整 MB 边界，不多不少）', async () => {
    const r = await h.service.presign({ ...base, size: MAX_FILE_SIZE }, user());
    expect(r.partCount).toBe(Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE));
  });

  it('【边界】2GB + 1 字节 → 4003 拒绝', async () => {
    await expect(
      h.service.presign({ ...base, size: MAX_FILE_SIZE + 1 }, user()),
    ).rejects.toMatchObject({ code: 4003 });
  });

  it('【边界】5MB 整 → 走非分片直传（multipart 判定为 size > 5MB）', async () => {
    const r = await h.service.presign({ ...base, size: CHUNK_SIZE }, user());
    expect(r.partCount).toBe(1);
    expect(r.putUrl).toBeTruthy();
    expect(r.uploadId).toBeNull();
  });

  it('【边界】5MB + 1 字节 → 启动分片上传', async () => {
    const r = await h.service.presign({ ...base, size: CHUNK_SIZE + 1 }, user());
    expect(r.uploadId).toBe('upload-1');
    expect(r.partCount).toBe(2);
  });

  it('非白名单 mime → 4002', async () => {
    await expect(
      h.service.presign({ ...base, mime: 'application/x-msdownload' }, user()),
    ).rejects.toMatchObject({ code: 4002 });
  });

  it('条目不存在 → 1004', async () => {
    await expect(h.service.presign({ ...base, itemId: 'nope' }, user())).rejects.toMatchObject({
      code: 1004,
    });
  });

  it('无权访问该条目（密级/范围不足）→ 1003', async () => {
    h.accessBuilder.canAccessRecord = vi.fn(() => false);
    await expect(h.service.presign(base, user())).rejects.toMatchObject({ code: 1003 });
  });
});

// ============================================================================
describe('complete —— SHA-256 完整性校验', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('哈希一致 → 落库并返回记录（含 sha256）', async () => {
    const dto = await h.service.complete(completeDto(), user());
    expect(dto.sha256).toBe(sha256Of(PDF_BYTES));
    expect(dto.extractStatus).toBe(ExtractStatus.PENDING);
    expect(h.saved).toHaveLength(1);
    expect(h.removed).toHaveLength(0);
  });

  it('落库成功后自动入抽取队列', async () => {
    await h.service.complete(completeDto(), user());
    expect(h.queueAdds).toHaveLength(1);
    expect(h.queueAdds[0].fileId).toBe('file-1');
  });

  it('入队失败不影响入库（降级为手动重投）', async () => {
    h.extractQueue.add.mockRejectedValueOnce(new Error('redis down'));
    const dto = await h.service.complete(completeDto(), user());
    expect(dto.id).toBe('file-1');
    expect(h.saved).toHaveLength(1);
  });

  it('【关键】哈希不一致 → 抛 FILE_HASH_MISMATCH(4001)', async () => {
    await expect(
      h.service.complete(completeDto({ sha256: 'f'.repeat(64) }), user()),
    ).rejects.toMatchObject({ code: 4001 });
  });

  it('【关键】哈希不一致时必须清理脏对象（MinIO 不留垃圾）', async () => {
    await expect(
      h.service.complete(completeDto({ sha256: 'f'.repeat(64) }), user()),
    ).rejects.toBeTruthy();
    expect(h.minio.removeObject).toHaveBeenCalledWith(
      'archive-original',
      expect.stringContaining('origin/'),
    );
    expect(h.removed).toHaveLength(1);
  });

  it('【关键】哈希不一致时绝不落库、绝不入队', async () => {
    await expect(
      h.service.complete(completeDto({ sha256: '0'.repeat(64) }), user()),
    ).rejects.toMatchObject({ code: 4001 });
    expect(h.fileRepo.save).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(0);
    expect(h.queueAdds).toHaveLength(0);
  });

  it('客户端哈希大小写不敏感（hex 大写也视为一致）', async () => {
    const upper = sha256Of(PDF_BYTES).toUpperCase();
    const dto = await h.service.complete(completeDto({ sha256: upper }), user());
    expect(dto.sha256).toBe(sha256Of(PDF_BYTES));
  });

  it('客户端未传 sha256 → 以服务端计算值为基线入库（不阻断）', async () => {
    const dto = await h.service.complete(completeDto({ sha256: '' }), user());
    expect(dto.sha256).toBe(sha256Of(PDF_BYTES));
  });

  it('对象不存在（分片未完成）→ 4004', async () => {
    h.minio.objectExists.mockResolvedValueOnce(false);
    await expect(h.service.complete(completeDto(), user())).rejects.toMatchObject({ code: 4004 });
  });

  it('分片合并失败 → 4004', async () => {
    h.minio.completeMultipart.mockRejectedValueOnce(new Error('InvalidPart'));
    await expect(
      h.service.complete(
        completeDto({ uploadId: 'upload-1', parts: [{ partNumber: 1, etag: 'e1' }] }),
        user(),
      ),
    ).rejects.toMatchObject({ code: 4004 });
  });

  it('【关键】魔数与声明 mime 不符（伪造扩展名）→ 4002 且清理对象', async () => {
    // 声明 PDF，实际内容是 PNG 头
    const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
    const h2 = makeHarness({ objectBytes: pngBytes });
    await expect(
      h2.service.complete(completeDto({ sha256: sha256Of(pngBytes) }), user()),
    ).rejects.toMatchObject({ code: 4002 });
    expect(h2.removed).toHaveLength(1);
    expect(h2.saved).toHaveLength(0);
  });

  it('无魔数规则的类型（text/plain）不做强校验，正常入库', async () => {
    const txt = Buffer.from('纯文本内容', 'utf8');
    const h2 = makeHarness({ objectBytes: txt });
    const dto = await h2.service.complete(
      completeDto({ mime: 'text/plain', filename: 'a.txt', sha256: sha256Of(txt) }),
      user(),
    );
    expect(dto.id).toBe('file-1');
  });

  it('条目不存在 → 1004', async () => {
    await expect(
      h.service.complete(completeDto({ itemId: 'nope' }), user()),
    ).rejects.toMatchObject({ code: 1004 });
  });
});

// ============================================================================
describe('integrityCheck —— 四性检测（完整性）', () => {
  it('对象与基线一致 → PASS', async () => {
    const h = makeHarness();
    h.fileRepo.findOne = vi.fn(async () => ({
      id: 'file-1',
      itemId: 'i-1',
      bucket: 'archive-original',
      objectKey: 'origin/a.pdf',
      sha256: sha256Of(PDF_BYTES),
      extractStatus: ExtractStatus.OK,
      mime: 'application/pdf',
      filename: 'a.pdf',
    }));
    const r = await h.service.integrityCheck('file-1', user());
    expect(r.integrity).toBe('PASS');
    expect(r.usability).toBe('PASS');
    expect(r.expectedSha256).toBe(r.actualSha256);
  });

  it('对象被篡改（哈希不符）→ FAIL', async () => {
    const h = makeHarness();
    h.fileRepo.findOne = vi.fn(async () => ({
      id: 'file-1',
      itemId: 'i-1',
      bucket: 'archive-original',
      objectKey: 'origin/a.pdf',
      sha256: 'a'.repeat(64),
      extractStatus: ExtractStatus.OK,
      mime: 'application/pdf',
      filename: 'a.pdf',
    }));
    const r = await h.service.integrityCheck('file-1', user());
    expect(r.integrity).toBe('FAIL');
  });

  it('对象读取异常 → FAIL（不抛出，返回结果供审计）', async () => {
    const h = makeHarness();
    h.fileRepo.findOne = vi.fn(async () => ({
      id: 'file-1',
      itemId: 'i-1',
      bucket: 'archive-original',
      objectKey: 'origin/a.pdf',
      sha256: 'a'.repeat(64),
      extractStatus: ExtractStatus.PENDING,
      mime: 'application/pdf',
      filename: 'a.pdf',
    }));
    h.minio.computeSha256.mockRejectedValueOnce(new Error('NoSuchKey'));
    const r = await h.service.integrityCheck('file-1', user());
    expect(r.integrity).toBe('FAIL');
    expect(r.actualSha256).toBe('');
  });
});

// ============================================================================
describe('download —— 下载策略受系统参数控制', () => {
  it('系统关闭下载 → 4007（默认策略 Q4）', async () => {
    const h = makeHarness();
    h.dict.isDownloadEnabled = vi.fn(async () => false);
    await expect(h.service.download('file-1', user())).rejects.toMatchObject({ code: 4007 });
  });
});
