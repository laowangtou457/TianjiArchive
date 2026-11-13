/**
 * 档号不可改 + 作废重编留痕 单元测试（apps/api/src/modules/archive/archive.service.ts）
 *
 * PRD 合规底线②：档号一经入库不可修改，唯一通道为 voidAndReassign（写审计 + 状态 + 新旧号）。
 * 覆盖：update / batchUpdate 均拒绝改号并抛 DANGHAO_IMMUTABLE(2004)；
 *       voidAndReassign 保留旧号痕迹、生成新号、写 voidHistory、重复作废被拒。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService } from '@api/modules/archive/archive.service';
import { ItemStatus, Retention, SecurityLevel, VolumeStatus } from '@tianji/shared';
import type { CreateItemDto, UpdateItemDto } from '@tianji/shared';

// ------------------------------------------------------------------ 夹具
type Row = Record<string, unknown>;

function itemRow(over: Partial<Row> = {}): Row {
  return {
    id: 'i-1',
    volumeId: null,
    fondsId: 'f-1',
    danghao: 'A036-2024-BGS-Y-0001-0001',
    title: '关于年度工作的报告',
    responsible: '办公室',
    docNo: 'BGS〔2024〕1号',
    docDate: '2024-03-01',
    year: 2024,
    retention: Retention.PERM,
    securityLevel: SecurityLevel.PUBLIC,
    categoryCode: null,
    classNo: null,
    keywords: [],
    pages: 3,
    note: null,
    status: ItemStatus.DRAFT,
    openFlag: 'CONTROLLED',
    extra: {},
    deleted: false,
    createdBy: 'u-1',
    createdAt: new Date('2024-03-01T00:00:00Z'),
    updatedAt: new Date('2024-03-01T00:00:00Z'),
    ...over,
  };
}

function makeHarness(initial: Row = itemRow()) {
  const state = { row: { ...initial } as Row };

  const itemRepo = {
    findOne: vi.fn(async ({ where }: { where: { id?: string; deleted?: boolean } }) => {
      if (where.id && where.id !== state.row.id) return null;
      if (where.deleted === false && state.row.deleted) return null;
      return { ...state.row };
    }),
    update: vi.fn(async (_w: unknown, patch: Row) => {
      state.row = { ...state.row, ...patch };
      return { affected: 1 };
    }),
    create: vi.fn((v: unknown) => v),
    save: vi.fn(async (v: Row) => v),
    find: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    query: vi.fn(async () => []),
    createQueryBuilder: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      execute: vi.fn(async () => ({ affected: 0 })),
    })),
  };

  const volumeRepo = {
    findOne: vi.fn(async () => null),
    update: vi.fn(async () => ({ affected: 1 })),
    decrement: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(() => ({})),
  };

  const generateItemDanghao = vi.fn(async () => ({
    danghao: 'A036-2024-BGS-Y-0002-0001',
    volumeNo: 2,
    itemNo: 1,
    scopeKey: 'A036|2024|BGS|Y|I:VOLUME',
  }));

  const ruleService = {
    generateItemDanghao,
    generateVolumeDanghao: vi.fn(async () => ({
      danghao: 'A036-2024-BGS-Y-0002',
      volumeNo: 2,
      scopeKey: 'A036|2024|BGS|Y|V:Y',
    })),
  };

  const manager = {
    update: vi.fn(async (_e: unknown, _w: unknown, patch: Row) => {
      state.row = { ...state.row, ...patch };
      return { affected: 1 };
    }),
    create: vi.fn((_e: unknown, v: unknown) => v),
    save: vi.fn(async (v: Row) => ({
      // created_at / updated_at 由实体 @CreateDateColumn / @UpdateDateColumn 填充
      id: v.id ?? `i-${Date.now()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...v,
    })),
    increment: vi.fn(async () => ({ affected: 1 })),
    // transitionStage 阶段流转：锁行读取（manager.getRepository(ArchiveItem).createQueryBuilder()）
    getRepository: vi.fn(() => ({
      createQueryBuilder: vi.fn(() => ({
        setLock: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        getMany: vi.fn(async () => [state.row]),
      })),
    })),
  };

  const dataSource = {
    transaction: vi.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };

  const fondsService = { assertFondsActive: vi.fn(async () => ({ id: 'f-1', fondsNo: 'A036' })) };
  const categoryService = {
    volumeFields: vi.fn(async () => []),
    itemFields: vi.fn(async () => []),
    validatePayload: vi.fn(() => []),
  };
  const recycleService = { record: vi.fn(async () => undefined) };

  const service = new ArchiveService(
    dataSource as never,
    volumeRepo as never,
    itemRepo as never,
    { findOne: vi.fn(async () => ({ id: 'f-1', fondsNo: 'A036' })) } as never, // fondsRepo
    { findOne: vi.fn(async () => null) } as never, // orgRepo
    { findOne: vi.fn(async () => null) } as never, // categoryRepo
    { count: vi.fn(async () => 0), query: vi.fn(async () => []) } as never, // fileRepo
    { create: vi.fn((_e: unknown, v: unknown) => v), save: vi.fn(async () => undefined), find: vi.fn(async () => []) } as never, // stageLogRepo
    ruleService as never,
    fondsService as never,
    categoryService as never,
    recycleService as never,
  );

  return { service, itemRepo, volumeRepo, manager, state, ruleService, recycleService };
}

// ============================================================================
describe('updateItem —— 档号不可改', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('【关键】普通更新路径传入不同档号 → DANGHAO_IMMUTABLE(2004)', async () => {
    await expect(
      h.service.updateItem({
        id: 'i-1',
        danghao: 'A036-2024-BGS-Y-9999-9999',
        title: '篡改档号',
      } as unknown as UpdateItemDto),
    ).rejects.toMatchObject({ code: 2004 });
    // 拒绝时必须不产生任何写入
    expect(h.itemRepo.update).not.toHaveBeenCalled();
    expect(h.state.row.danghao).toBe('A036-2024-BGS-Y-0001-0001');
  });

  it('传入与原档号相同的值 → 允许（前端整表单回传场景）', async () => {
    const dto = await h.service.updateItem({
      id: 'i-1',
      danghao: 'A036-2024-BGS-Y-0001-0001',
      title: '修改后的题名',
    } as unknown as UpdateItemDto);
    expect(dto.title).toBe('修改后的题名');
    expect(dto.danghao).toBe('A036-2024-BGS-Y-0001-0001');
  });

  it('不传档号 → 正常更新其他字段，档号保持不变', async () => {
    const dto = await h.service.updateItem({ id: 'i-1', title: '新题名' } as UpdateItemDto);
    expect(dto.title).toBe('新题名');
    expect(dto.danghao).toBe('A036-2024-BGS-Y-0001-0001');
  });

  it('已作废条目不可修改 → 1001（避免绕过作废流程）', async () => {
    h = makeHarness(itemRow({ status: ItemStatus.VOID }));
    await expect(
      h.service.updateItem({ id: 'i-1', title: '试图修改作废件' } as UpdateItemDto),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('条目不存在 → 1004', async () => {
    await expect(
      h.service.updateItem({ id: 'not-exist', title: 'x' } as UpdateItemDto),
    ).rejects.toMatchObject({ code: 1004 });
  });

  it('更新时档号字段不会被透传到 UPDATE 语句（二次确认）', async () => {
    await h.service.updateItem({ id: 'i-1', title: '只改题名' } as UpdateItemDto);
    const patch = (h.itemRepo.update.mock.calls[0]?.[1] ?? {}) as Row;
    expect('danghao' in patch).toBe(false);
  });
});

// ============================================================================
describe('batchUpdate —— 档号不可改', () => {
  it('【关键】批量修改含 danghao 字段 → 2004，且不执行 SQL', async () => {
    const h = makeHarness();
    await expect(
      h.service.batchUpdate({
        ids: ['i-1', 'i-2'],
        patch: { danghao: 'X-1' } as never,
      }),
    ).rejects.toMatchObject({ code: 2004 });
    expect(h.itemRepo.query).not.toHaveBeenCalled();
  });

  it('空 ids → 1001', async () => {
    const h = makeHarness();
    await expect(h.service.batchUpdate({ ids: [], patch: { title: 't' } })).rejects.toMatchObject({
      code: 1001,
    });
  });

  it('无任何可改字段 → 1001', async () => {
    const h = makeHarness();
    await expect(
      h.service.batchUpdate({ ids: ['i-1'], patch: {} as never }),
    ).rejects.toMatchObject({ code: 1001 });
  });
});

// ============================================================================
describe('voidAndReassign —— 档号唯一可变通道（留痕）', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('作废原因过短（<2 字）→ 1001，且不改变任何数据', async () => {
    await expect(
      h.service.voidAndReassign('i-1', { reason: '错' } as never, 'u-admin'),
    ).rejects.toMatchObject({ code: 1001 });
    expect(h.state.row.danghao).toBe('A036-2024-BGS-Y-0001-0001');
  });

  it('【关键】作废重编：返回旧号 + 新号，状态回 DRAFT，旧号进入 voidHistory', async () => {
    const result = await h.service.voidAndReassign(
      'i-1',
      { reason: '档号编制错误，需重新编制', reassign: true } as never,
      'u-admin',
    );

    expect(result.oldDanghao).toBe('A036-2024-BGS-Y-0001-0001');
    expect(result.newDanghao).toBe('A036-2024-BGS-Y-0002-0001');
    expect(result.status).toBe(ItemStatus.DRAFT);
    expect(h.state.row.danghao).toBe('A036-2024-BGS-Y-0002-0001');

    const history = (h.state.row.extra as { voidHistory: Array<Record<string, unknown>> })
      .voidHistory;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      oldDanghao: 'A036-2024-BGS-Y-0001-0001',
      newDanghao: 'A036-2024-BGS-Y-0002-0001',
      reason: '档号编制错误，需重新编制',
      operatorId: 'u-admin',
    });
    expect(typeof history[0].at).toBe('string');
  });

  it('作废重编过程中先释放旧唯一键（避免 uk 冲突）', async () => {
    await h.service.voidAndReassign('i-1', { reason: '重新编制档号' } as never, 'u-admin');
    const firstPatch = h.manager.update.mock.calls[0]?.[2] as Row;
    expect(String(firstPatch.danghao)).toContain('~VOID~');
  });

  it('reassign=false → 仅作废，状态 VOID，不生成新号', async () => {
    const result = await h.service.voidAndReassign(
      'i-1',
      { reason: '条目重复录入', reassign: false } as never,
      'u-admin',
    );
    expect(result.newDanghao).toBeNull();
    expect(result.status).toBe(ItemStatus.VOID);
    expect(h.state.row.status).toBe(ItemStatus.VOID);
    expect(String(h.state.row.danghao)).toContain('~VOID~');
  });

  it('已作废条目不可重复作废 → 1001', async () => {
    h = makeHarness(itemRow({ status: ItemStatus.VOID }));
    await expect(
      h.service.voidAndReassign('i-1', { reason: '重复作废' } as never, 'u-admin'),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('条目不存在 → 1004', async () => {
    await expect(
      h.service.voidAndReassign('nope', { reason: '不存在' } as never, 'u-admin'),
    ).rejects.toMatchObject({ code: 1004 });
  });

  it('多次作废累积留痕（可追溯完整链路）', async () => {
    await h.service.voidAndReassign('i-1', { reason: '第一次重编' } as never, 'u-admin');
    await h.service.voidAndReassign('i-1', { reason: '第二次重编' } as never, 'u-admin');
    const history = (h.state.row.extra as { voidHistory: unknown[] }).voidHistory;
    expect(history).toHaveLength(2);
  });
});

// ============================================================================
describe('createItem —— 档号由服务端分配，不接受客户端传入', () => {
  it('创建件时档号取自分号服务，DTO 中的 danghao 被忽略', async () => {
    const h = makeHarness();
    h.itemRepo.save = vi.fn(async (v: Row) => v);
    const dto = await h.service.createItem(
      {
        fondsId: 'f-1',
        title: '新条目',
        responsible: '办公室',
        docDate: '2024-05-01',
        danghao: 'HACKED-0001', // 恶意传入
      } as unknown as CreateItemDto,
      'u-1',
    );
    expect(dto.danghao).toBe('A036-2024-BGS-Y-0002-0001');
    expect(dto.danghao).not.toContain('HACKED');
  });
});

// ============================================================================
describe('卷 / 件 状态流转', () => {
  it('已作废案卷不可归档 → 1001', async () => {
    const h = makeHarness();
    h.volumeRepo.findOne = vi.fn(async () => ({
      id: 'v-1',
      danghao: 'A036-2024-BGS-Y-0001',
      status: VolumeStatus.VOID,
      deleted: false,
    }));
    await expect(h.service.confirmVolume('v-1')).rejects.toMatchObject({ code: 1001 });
  });

  it('仅 DRAFT 件可提交归档，否则 1001', async () => {
    const h = makeHarness(itemRow({ status: ItemStatus.ARCHIVED }));
    await expect(h.service.submitItem('i-1')).rejects.toMatchObject({ code: 1001 });
  });

  it('DRAFT 件提交归档 → SUBMITTED', async () => {
    const h = makeHarness();
    const dto = await h.service.submitItem('i-1');
    expect(dto.status).toBe(ItemStatus.SUBMITTED);
  });
});
