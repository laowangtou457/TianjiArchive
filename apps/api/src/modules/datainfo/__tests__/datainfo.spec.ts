/**
 * P5 新模块服务层单元测试（数据导入 / 保管期限表 / 销毁批次）。
 *
 * 全部依赖 Repository / ArchiveService 均为 mock，不连数据库。
 * 覆盖：批次建立、CSV 解析与档号必填校验、确认入库跳过重复档号、
 *       期限表 CRUD 与编码冲突、销毁批次建立/审核/执行与留痕。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataInfoService } from '../datainfo.service';
import { RetentionService } from '../../retention/retention.service';
import { DestroyService } from '../../destroy/destroy.service';

// ------------------------------------------------------------------ mock 工具

type Row = Record<string, unknown>;

function mockRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const repo: Record<string, unknown> = {
    find: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn((input: Row) => ({ ...input })),
    save: vi.fn(async (input: Row | Row[]) => {
      const withTime = (r: Row): Row => ({
        createdAt: r.createdAt ?? new Date('2026-01-01T00:00:00Z'),
        updatedAt: r.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
        ...r,
      });
      if (Array.isArray(input)) {
        return input.map((r, i) => withTime({ id: `entry-${i}`, ...r }));
      }
      return withTime({ id: 'generated-id', ...input });
    }),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    delete: vi.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: vi.fn(() => {
      const qb: Record<string, unknown> = {};
      for (const method of ['insert', 'into', 'values', 'orIgnore']) {
        qb[method] = vi.fn(() => qb);
      }
      qb.execute = vi.fn().mockResolvedValue({ affected: 0 });
      return qb;
    }),
    ...overrides,
  };
  return repo;
}

function makeBatch(over: Row = {}): Row {
  return {
    id: 'batch-1',
    batchNo: 'IMP20260101-ABC123',
    name: '测试批次',
    status: 'CREATED',
    templateJson: [],
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    confirmedAt: null,
    fileCount: 0,
    successCount: 0,
    failCount: 0,
    detailJson: [],
    ...over,
  };
}

// ------------------------------------------------------------------ 数据导入

describe('DataInfoService（数据导入）', () => {
  let batchRepo: Record<string, unknown>;
  let itemRepo: Record<string, unknown>;
  let fondsRepo: Record<string, unknown>;
  let service: DataInfoService;

  beforeEach(() => {
    batchRepo = mockRepo();
    itemRepo = mockRepo();
    fondsRepo = mockRepo();
    service = new DataInfoService(
      batchRepo as never,
      itemRepo as never,
      fondsRepo as never,
    );
  });

  it('建立批次：生成批次号、状态 CREATED、操作人落库', async () => {
    const dto = await service.createBatch({ name: '  2026 移交  ' }, 'user-1');
    expect(dto.name).toBe('2026 移交');
    expect(dto.status).toBe('CREATED');
    expect(dto.batchNo).toMatch(/^IMP\d{8}-[0-9A-Z]{6}$/);
    expect(dto.createdBy).toBe('user-1');
    expect(batchRepo.save).toHaveBeenCalledTimes(1);
  });

  it('空名称建立批次被拒绝', async () => {
    await expect(service.createBatch({ name: '  ' })).rejects.toThrow();
  });

  it('上传 CSV：解析明细、校验档号必填、统计成功失败行', async () => {
    let current = makeBatch();
    batchRepo.findOne = vi.fn().mockImplementation(async () => current);
    batchRepo.update = vi.fn().mockImplementation(async (_where: Row, patch: Row) => {
      current = { ...current, ...patch };
    });
    batchRepo.find = vi.fn().mockImplementation(async () => [current]);

    const result = await service.upload(
      'batch-1',
      {
        content:
          '档号,题名,责任者,年度,密级\n' +
          'DA-001,通知,办公室,2026,PUBLIC\n' +
          ',缺档号,办公室,2026,PUBLIC',
      },
      'user-1',
    );

    expect(result.status).toBe('UPLOADED');
    expect(result.fileCount).toBe(2);
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.details[0].danghao).toBe('DA-001');
    expect(result.details[0].valid).toBe(true);
    expect(result.details[1].error).toBe('档号必填');
    expect(result.details[1].valid).toBe(false);
  });

  it('确认入库：有效明细批量写入，已存在档号跳过且不重复插入', async () => {
    let current = makeBatch({
      status: 'UPLOADED',
      detailJson: [
        {
          line: 1,
          values: {},
          danghao: 'DA-NEW',
          title: '新条目',
          responsible: null,
          year: 2026,
          securityLevel: 'PUBLIC',
          valid: true,
          error: null,
          imported: false,
        },
        {
          line: 2,
          values: {},
          danghao: 'DA-OLD',
          title: '已存在',
          responsible: null,
          year: 2025,
          securityLevel: 'PUBLIC',
          valid: true,
          error: null,
          imported: false,
        },
      ],
    });
    batchRepo.findOne = vi.fn().mockImplementation(async () => current);
    batchRepo.update = vi.fn().mockImplementation(async (_where: Row, patch: Row) => {
      current = { ...current, ...patch };
    });
    itemRepo.find = vi.fn().mockResolvedValue([{ danghao: 'DA-OLD' }]);
    fondsRepo.findOne = vi.fn().mockResolvedValue({ id: 'fonds-1' });

    const result = await service.confirm('batch-1', 'user-1');

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.batch.status).toBe('CONFIRMED');
    const qb = itemRepo.createQueryBuilder.mock.results[0].value as Record<string, unknown>;
    const valuesArg = (qb.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as Row[];
    expect(valuesArg).toHaveLength(1);
    expect(valuesArg[0].danghao).toBe('DA-NEW');
    expect(valuesArg[0].fondsId).toBe('fonds-1');
    expect(result.batch.details.find((d) => d.danghao === 'DA-OLD')?.error).toBe('档号已存在，已跳过');
  });

  it('未上传即确认被拒绝', async () => {
    batchRepo.findOne = vi.fn().mockResolvedValue(makeBatch());
    await expect(service.confirm('batch-1')).rejects.toThrow();
  });

  it('批次列表返回 DTO', async () => {
    batchRepo.find = vi.fn().mockResolvedValue([makeBatch()]);
    const rows = await service.listBatches();
    expect(rows).toHaveLength(1);
    expect(rows[0].batchNo).toBe('IMP20260101-ABC123');
  });
});

// ------------------------------------------------------------------ 保管期限表

describe('RetentionService（保管期限表）', () => {
  let planRepo: Record<string, unknown>;
  let service: RetentionService;

  beforeEach(() => {
    planRepo = mockRepo();
    service = new RetentionService(planRepo as never);
  });

  it('新增期限方案', async () => {
    planRepo.save = vi.fn().mockImplementation(async (row: Row) => ({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      id: 'plan-1',
      ...row,
    }));
    const dto = await service.create({
      code: 'Y30',
      name: '定期30年',
      years: 30,
      level: 'Y30',
      description: '依据保管期限规定',
      enabled: true,
    });
    expect(dto.code).toBe('Y30');
    expect(dto.years).toBe(30);
    expect(dto.enabled).toBe(true);
  });

  it('重复编码新增被拒绝', async () => {
    planRepo.findOne = vi.fn().mockResolvedValue({ id: 'other', code: 'Y10' });
    await expect(service.create({ code: 'Y10', name: '定期10年', years: 10 })).rejects.toThrow();
  });

  it('编辑期限方案（改名与停用）', async () => {
    const existing = {
      id: 'plan-1',
      code: 'Y30',
      name: '定期30年',
      years: 30,
      level: 'Y30',
      description: null,
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    planRepo.findOne = vi.fn().mockResolvedValue(existing);
    planRepo.save = vi.fn().mockImplementation(async (row: Row) => ({ ...row }));
    const dto = await service.update('plan-1', { name: '三十年', enabled: false });
    expect(dto.name).toBe('三十年');
    expect(dto.enabled).toBe(false);
  });

  it('删除期限方案', async () => {
    planRepo.findOne = vi.fn().mockResolvedValue({ id: 'plan-1', code: 'Y30' });
    const res = await service.remove('plan-1');
    expect(res.removed).toBe(true);
    expect(planRepo.delete).toHaveBeenCalledWith({ id: 'plan-1' });
  });

  it('不存在的方案编辑被拒绝', async () => {
    await expect(service.update('missing', { name: 'x' })).rejects.toThrow();
  });
});

// ------------------------------------------------------------------ 销毁批次

describe('DestroyService（销毁批次）', () => {
  let batchRepo: Record<string, unknown>;
  let entryRepo: Record<string, unknown>;
  let itemRepo: Record<string, unknown>;
  let recycleRepo: Record<string, unknown>;
  let archiveService: { softDeleteItem: ReturnType<typeof vi.fn> };
  let service: DestroyService;

  beforeEach(() => {
    batchRepo = mockRepo();
    entryRepo = mockRepo();
    itemRepo = mockRepo();
    // 新增 RecycleBin 仓储（还原链路），构造参数位置必须与 Service 一致
    recycleRepo = mockRepo();
    archiveService = { softDeleteItem: vi.fn().mockResolvedValue({ deleted: true }) };
    service = new DestroyService(
      batchRepo as never,
      entryRepo as never,
      itemRepo as never,
      recycleRepo as never,
      archiveService as never,
    );
  });

  it('建立批次：按档号匹配条目并生成明细（含未匹配留痕）', async () => {
    batchRepo.save = vi.fn().mockImplementation(async (row: Row) => ({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      id: 'batch-1',
      ...row,
    }));
    itemRepo.find = vi.fn().mockResolvedValue([
      { id: 'item-1', danghao: 'DA-001', title: '材料一' },
    ]);

    const dto = await service.createBatch(
      { reason: '到期销毁', danghaos: ['DA-001', 'DA-999'] },
      'user-1',
    );

    expect(dto.status).toBe('PENDING');
    expect(dto.itemIds).toEqual(['item-1']);
    const savedEntries = (entryRepo.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as Row[];
    expect(savedEntries).toHaveLength(2);
    expect(savedEntries.find((e) => e.danghao === 'DA-001')?.result).toBe('PENDING');
    expect(savedEntries.find((e) => e.danghao === 'DA-999')?.result).toBe('NOT_FOUND');
  });

  it('审核通过：PENDING → APPROVED', async () => {
    let current = {
      id: 'batch-1',
      batchNo: 'DES20260101-ABC123',
      reason: '到期销毁',
      status: 'PENDING',
      itemIdsJson: ['item-1'],
      createdBy: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    batchRepo.findOne = vi.fn().mockImplementation(async () => current);
    batchRepo.update = vi.fn().mockImplementation(async (_where: Row, patch: Row) => {
      current = { ...current, ...patch };
    });
    const dto = await service.approve('batch-1');
    expect(dto.status).toBe('APPROVED');
  });

  it('执行销毁：逐条软删除并写留痕，状态置 DESTROYED', async () => {
    let current = {
      id: 'batch-1',
      batchNo: 'DES20260101-ABC123',
      reason: '到期销毁',
      status: 'APPROVED',
      itemIdsJson: ['item-1'],
      createdBy: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    batchRepo.findOne = vi.fn().mockImplementation(async () => current);
    batchRepo.update = vi.fn().mockImplementation(async (_where: Row, patch: Row) => {
      current = { ...current, ...patch };
    });
    entryRepo.find = vi.fn().mockResolvedValue([
      { id: 'entry-1', batchId: 'batch-1', itemId: 'item-1', danghao: 'DA-001', title: '材料一', result: 'PENDING' },
      { id: 'entry-2', batchId: 'batch-1', itemId: null, danghao: 'DA-999', title: null, result: 'NOT_FOUND' },
    ]);

    const result = await service.execute('batch-1', 'user-1');

    expect(result.destroyed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.batch.status).toBe('DESTROYED');
    expect(archiveService.softDeleteItem).toHaveBeenCalledTimes(1);
    expect(archiveService.softDeleteItem).toHaveBeenCalledWith('item-1', 'user-1');
    const updates = (entryRepo.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates.some((call: Row[]) => call[1].result === 'DESTROYED')).toBe(true);
  });

  it('未审核即执行被拒绝', async () => {
    batchRepo.findOne = vi.fn().mockResolvedValue({
      id: 'batch-1',
      batchNo: 'DES1',
      reason: 'x',
      status: 'PENDING',
      itemIdsJson: [],
      createdBy: null,
      createdAt: new Date(),
    });
    await expect(service.execute('batch-1')).rejects.toThrow();
  });

  it('查询明细返回 DTO', async () => {
    batchRepo.findOne = vi.fn().mockResolvedValue({
      id: 'batch-1',
      batchNo: 'DES1',
      reason: 'x',
      status: 'APPROVED',
      itemIdsJson: [],
      createdBy: null,
      createdAt: new Date(),
    });
    entryRepo.find = vi.fn().mockResolvedValue([
      { id: 'entry-1', batchId: 'batch-1', itemId: 'item-1', danghao: 'DA-001', title: 'A', result: 'PENDING', createdAt: new Date() },
    ]);
    const rows = await service.entries('batch-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].danghao).toBe('DA-001');
  });
});
