/**
 * P5 批量操作 + 条目导出 单元测试（archive.service.ts）
 *
 * 覆盖：
 *  - batchUpdate 的 replace 语义（replace() SQL + 位置参数 + LIKE 行过滤）与 set 回归；
 *  - batchReorder 按档号/题名排序并把序号写入 extra.sortNo（QueryBuilder 事务）；
 *  - exportItems 的 CSV（UTF-8 BOM / 转义 / 中文标签）、XML（结构 / 转义）、
 *    权限行级过滤条件与入参校验。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService } from '@api/modules/archive/archive.service';
import { AccessFilterBuilder } from '@api/common/access/access-filter.builder';
import { ItemStatus, Retention, SecurityLevel } from '@tianji/shared';
import type { PermissionSnapshot } from '@tianji/shared';

type Row = Record<string, unknown>;

function itemRow(over: Partial<Row> = {}): Row {
  return {
    id: 'i-1',
    volumeId: 'v-1',
    fondsId: 'f-1',
    danghao: 'A-0001',
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
    openScope: 'NONE',
    fullText: null,
    extra: {},
    deleted: false,
    createdBy: 'u-1',
    archivedBy: null,
    archivedAt: null,
    createdAt: new Date('2024-03-01T00:00:00Z'),
    updatedAt: new Date('2024-03-01T00:00:00Z'),
    ...over,
  };
}

function user(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    userId: 'u-1',
    username: 'tester',
    displayName: '测试用户',
    roles: [],
    grants: {},
    maxSecurityLevel: SecurityLevel.SECRET,
    fondsIds: null,
    orgIds: null,
    selfOnly: false,
    scopes: [],
    ...over,
  };
}

function makeHarness(initial: Row[] = [itemRow()]) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const andWhereCalls: Array<{ cond: string; params: Record<string, unknown> }> = [];

  const itemRepo = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rowCount: rows.length };
    }),
    find: vi.fn(async ({ where }: { where?: { id?: string[] } }) => {
      if (where?.id && Array.isArray(where.id)) {
        return rows.filter((r) => where.id!.includes(r.id as string)).map((r) => ({ ...r }));
      }
      return rows.map((r) => ({ ...r }));
    }),
    createQueryBuilder: vi.fn(() => {
      const qb: Record<string, unknown> = {};
      qb.where = vi.fn().mockReturnValue(qb);
      qb.andWhere = vi.fn((cond: string, params?: Record<string, unknown>) => {
        andWhereCalls.push({ cond, params: params ?? {} });
        return qb;
      });
      qb.orderBy = vi.fn().mockReturnValue(qb);
      qb.take = vi.fn().mockReturnValue(qb);
      qb.getMany = vi.fn(async () => rows.map((r) => ({ ...r })));
      return qb;
    }),
  };

  const reorderUpdates: Array<{ id: string; extraSql: string }> = [];
  const reorderQb: Record<string, unknown> = {};
  reorderQb.update = vi.fn().mockReturnValue(reorderQb);
  reorderQb.set = vi.fn((patch: { extra: () => string }) => {
    reorderUpdates.push({ id: '', extraSql: patch.extra() });
    return reorderQb;
  });
  reorderQb.where = vi.fn((_cond: string, params: { id: string }) => {
    reorderUpdates[reorderUpdates.length - 1].id = params.id;
    return reorderQb;
  });
  reorderQb.execute = vi.fn(async () => ({ affected: 1 }));
  const manager = { createQueryBuilder: vi.fn(() => reorderQb) };
  const dataSource = {
    transaction: vi.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };

  const esIndexer = { enqueue: vi.fn(), enqueueMany: vi.fn() };
  const service = new ArchiveService(
    dataSource as never,
    {} as never, // volumeRepo
    itemRepo as never,
    {} as never, // fondsRepo
    {} as never, // orgRepo
    {} as never, // categoryRepo
    {} as never, // fileRepo
    {} as never, // stageLogRepo
    {} as never, // ruleService
    {} as never, // fondsService
    {} as never, // categoryService
    {} as never, // recycleService
    new AccessFilterBuilder() as never,
    esIndexer as never,
  );

  return { service, itemRepo, queries, andWhereCalls, reorderUpdates, esIndexer, rows, dataSource };
}

// ============================================================================
describe('batchUpdate —— 查找替换语义与参数绑定', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    // 两条记录：一条含“办公室”，一条不含，用于验证 LIKE 行过滤只更新命中行
    h = makeHarness([
      itemRow({ id: 'i-1', title: '关于年度工作的报告', responsible: '办公室' }),
      itemRow({ id: 'i-2', title: '会议纪要', responsible: '秘书处' }),
    ]);
  });

  it('replace 模式：对文本字段生成 replace(...) 并绑定位置参数 + LIKE 过滤', async () => {
    const r = await h.service.batchUpdate({
      ids: ['i-1', 'i-2'],
      patch: { responsible: '综合办' },
      mode: 'replace',
      search: '办公室',
    });

    expect(r.requested).toBe(2);
    const { sql, params } = h.queries[0];
    // $1 = ids；$2 = search；$3 = 新值；$4 = LIKE
    expect(sql).toContain('replace("responsible", $2, $3)');
    expect(sql).toContain('"responsible" ILIKE $4');
    expect(params[0]).toEqual(['i-1', 'i-2']);
    expect(params[1]).toBe('办公室');
    expect(params[2]).toBe('综合办');
    expect(params[3]).toBe('%办公室%');
  });

  it('replace 模式：枚举/数字字段不会生成 replace（无替换语义）', async () => {
    await expect(
      h.service.batchUpdate({
        ids: ['i-1'],
        patch: { pages: 9 },
        mode: 'replace',
        search: '3',
      }),
    ).rejects.toMatchObject({ code: 1001 });
    expect(h.queries).toHaveLength(0);
  });

  it('replace 模式缺少查找值 → 1001', async () => {
    await expect(
      h.service.batchUpdate({
        ids: ['i-1'],
        patch: { title: 'x' },
        mode: 'replace',
      }),
    ).rejects.toMatchObject({ code: 1001 });
  });

  it('set 模式回归：值按位置参数绑定（修复命名参数未绑定问题）', async () => {
    await h.service.batchUpdate({ ids: ['i-1'], patch: { title: '新题名', pages: 8 } });
    const { sql, params } = h.queries[0];
    expect(sql).toContain('"title" = $2');
    expect(sql).toContain('"pages" = $3');
    expect(params.slice(1)).toEqual(['新题名', 8]);
  });
});

// ============================================================================
describe('batchReorder —— 按字段排序并写入序号', () => {
  it('按档号升序：写回 extra.sortNo = 1/2（QueryBuilder 事务）', async () => {
    const h = makeHarness([
      itemRow({ id: 'i-2', danghao: 'B-0002', title: '乙' }),
      itemRow({ id: 'i-1', danghao: 'A-0001', title: '甲' }),
    ]);
    const r = await h.service.batchReorder({ ids: ['i-2', 'i-1'], by: 'danghao', order: 'asc' });
    expect(r).toEqual({ requested: 2, updated: 2 });
    expect(h.reorderUpdates.map((u) => u.id)).toEqual(['i-1', 'i-2']);
    expect(h.reorderUpdates[0].extraSql).toContain('to_jsonb(1)');
    expect(h.reorderUpdates[1].extraSql).toContain('to_jsonb(2)');
    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('按题名降序：序号方向与排序一致', async () => {
    const h = makeHarness([
      itemRow({ id: 'i-1', title: '甲' }),
      itemRow({ id: 'i-2', title: '乙' }),
    ]);
    await h.service.batchReorder({ ids: ['i-1', 'i-2'], by: 'title', order: 'desc' });
    expect(h.reorderUpdates.map((u) => u.id)).toEqual(['i-2', 'i-1']);
  });

  it('空 ids → 1001', async () => {
    const h = makeHarness();
    await expect(h.service.batchReorder({ ids: [], by: 'danghao' })).rejects.toMatchObject({
      code: 1001,
    });
  });
});

// ============================================================================
describe('exportItems —— CSV / XML / 权限过滤', () => {
  const twoItems = [
    itemRow({ id: 'i-1', danghao: 'A-0001', title: '关于年度工作的报告', responsible: '办公室' }),
    itemRow({
      id: 'i-2',
      danghao: 'A-0002',
      title: '会议,纪要 "摘要"',
      responsible: '<内部>',
      securityLevel: SecurityLevel.SECRET,
    }),
  ];

  it('CSV：带 UTF-8 BOM、中文表头、逗号/引号转义', async () => {
    const h = makeHarness(twoItems);
    const file = await h.service.exportItems({ ids: ['i-1', 'i-2'], format: 'csv' });
    const text = file.buffer.toString('utf8');
    expect(file.contentType).toContain('text/csv');
    expect(file.filename).toMatch(/\.csv$/);
    expect(file.count).toBe(2);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('档号,题名,责任者');
    expect(text).toContain('永久'); // RETENTION_LABELS
    expect(text).toContain('"会议,纪要 ""摘要"""'); // 逗号+引号转义
  });

  it('XML：结构为 <items><item><danghao>，且特殊字符转义', async () => {
    const h = makeHarness(twoItems);
    const file = await h.service.exportItems({ ids: ['i-1', 'i-2'], format: 'xml' });
    const text = file.buffer.toString('utf8');
    expect(file.contentType).toContain('application/xml');
    expect(file.filename).toMatch(/\.xml$/);
    expect(text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(text).toContain('<items>');
    expect(text).toContain('<danghao>A-0001</danghao>');
    expect(text).toContain('&lt;内部&gt;'); // responsible 转义
  });

  it('按用户密级/数据范围追加行级过滤条件', async () => {
    const h = makeHarness(twoItems);
    await h.service.exportItems(
      { volumeId: 'v-1', format: 'csv' },
      user({ maxSecurityLevel: SecurityLevel.PUBLIC, fondsIds: ['f-1'] }),
    );
    expect(h.andWhereCalls.some((c) => c.cond.includes('i.securityLevel IN (:...levels)'))).toBe(
      true,
    );
    const levelCall = h.andWhereCalls.find((c) => c.cond.includes('securityLevel IN'))!;
    expect(levelCall.params.levels).toEqual(['PUBLIC']);
    const scopeCall = h.andWhereCalls.find((c) => c.cond.includes(':...scopeFonds'))!;
    expect(scopeCall.params.scopeFonds).toEqual(['f-1']);
  });

  it('数据范围为空时不查询、导出空文件', async () => {
    const h = makeHarness(twoItems);
    const file = await h.service.exportItems(
      { volumeId: 'v-1', format: 'csv' },
      user({ fondsIds: [] }),
    );
    expect(file.count).toBe(0);
    expect(h.andWhereCalls).toHaveLength(0);
  });

  it('非法格式 / 未指定范围 / 超过 5000 条 → 1001', async () => {
    const h = makeHarness();
    await expect(
      h.service.exportItems({ volumeId: 'v-1', format: 'json' as 'csv' }),
    ).rejects.toMatchObject({ code: 1001 });
    await expect(h.service.exportItems({ format: 'csv' })).rejects.toMatchObject({ code: 1001 });
    await expect(
      h.service.exportItems({ ids: Array.from({ length: 5001 }, (_, i) => `id-${i}`), format: 'csv' }),
    ).rejects.toMatchObject({ code: 1001 });
  });
});
