import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { AuditLogService } from '../../audit/audit-log.service';
import { ExtensionRecord } from '../../../infra/database/entities/extension-record.entity';
import {
  domainForCategory,
  ExtensionService,
  type ExtensionActionDto,
} from '../extension.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user';

const DOMAINS = [
  'FONDS', 'VOLUME', 'ITEM', 'DANGHAO_RULE', 'ARCHIVE_CONFIRM', 'SEARCH',
  'SEARCH_INTERNAL', 'FILE', 'PREVIEW', 'BORROW_APPLY', 'BORROW_APPROVE',
  'BORROW_RETURN', 'REPORT', 'COMPILATION', 'APPRAISAL', 'RECYCLE', 'USER',
  'AUDIT_LOG', 'BACKUP', 'IMPORT_EXPORT', 'PARAM', 'DICT', 'KB', 'WIKI',
] as const;

/** 全授权用户（绕过角色差异，专注验证分类域映射与状态流转） */
function fullUser(overrides: Record<string, unknown> = {}): AuthenticatedUser {
  const grants: Record<string, unknown> = {};
  for (const d of DOMAINS) {
    grants[d] = { mode: 'FULL', ops: ['READ', 'WRITE', 'APPROVE', 'DELETE', 'EXPORT'], scoped: false, levelCapped: false };
  }
  return {
    userId: 'user-1',
    username: 'tester',
    sessionId: 'session-1',
    maxSecurityLevel: 'PUBLIC',
    grants,
    ...overrides,
  } as unknown as AuthenticatedUser;
}

function makeRow(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'rec-1',
    category: 'RECEIVE_PACKAGE',
    title: '接收包 A',
    bodyJson: { count: 3 },
    status: 'PENDING',
    enabled: true,
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as ExtensionRecord;
}

function setup(initial: ExtensionRecord[] = []): {
  service: ExtensionService;
  repo: Repository<ExtensionRecord>;
  audit: { append: ReturnType<typeof vi.fn> };
  qb: Record<string, ReturnType<typeof vi.fn>>;
  data: ExtensionRecord[];
} {
  const data = [...initial];
  const qb = {
    orderBy: vi.fn().mockReturnThis(),
    addOrderBy: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getManyAndCount: vi.fn(async () => [data, data.length]),
  };
  const repo = {
    createQueryBuilder: vi.fn(() => qb),
    create: vi.fn((obj: Partial<ExtensionRecord>) => ({
      ...obj,
      id: 'gen-1',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    })),
    save: vi.fn(async (obj: ExtensionRecord) => obj),
    findOne: vi.fn(async ({ where }: { where: { id: string } }) => data.find((r) => r.id === where.id) ?? null),
    update: vi.fn(async ({ id }: { id: string }, patch: Partial<ExtensionRecord>) => {
      const row = data.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return { affected: row ? 1 : 0 };
    }),
    delete: vi.fn(async ({ id }: { id: string }) => {
      const idx = data.findIndex((r) => r.id === id);
      if (idx >= 0) data.splice(idx, 1);
      return { affected: 1 };
    }),
  } as unknown as Repository<ExtensionRecord>;
  const audit = { append: vi.fn(async () => undefined) };
  const service = new ExtensionService(repo, audit as unknown as AuditLogService);
  return { service, repo, audit, qb, data };
}

describe('ExtensionService（mock repository）', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('category → 功能域映射符合需求约定', () => {
    expect(domainForCategory('RECEIVE_PACKAGE')).toBe('IMPORT_EXPORT');
    expect(domainForCategory('DATALINK_BATCH')).toBe('IMPORT_EXPORT');
    expect(domainForCategory('TRANSFER')).toBe('IMPORT_EXPORT');
    expect(domainForCategory('ERMS_PACKAGE')).toBe('BACKUP');
    expect(domainForCategory('ERCHECK_ITEM')).toBe('BACKUP');
    expect(domainForCategory('STOCK_ROOM')).toBe('PARAM');
    expect(domainForCategory('AUX_ENTITY')).toBe('PARAM');
    expect(domainForCategory('TEMPLATE')).toBe('PARAM');
    expect(domainForCategory('METADATA')).toBe('PARAM');
    expect(domainForCategory('CATEGORY_TEMPLATE')).toBe('PARAM');
    expect(domainForCategory('COMPILATION')).toBe('COMPILATION');
    expect(domainForCategory('NOTICE')).toBe('PARAM');
    expect(domainForCategory('DOWNLOAD')).toBe('PARAM');
    expect(domainForCategory('REPORT_DESIGN')).toBe('PARAM');
    expect(domainForCategory('USAGE_LOG')).toBe('AUDIT_LOG');
    expect(domainForCategory('UNKNOWN')).toBe('PARAM');
  });

  it('list 返回 {list,total} 并按 category/status 过滤', async () => {
    ctx = setup([makeRow(), makeRow({ id: 'rec-2', category: 'NOTICE', status: 'PUBLISHED' })]);
    const res = await ctx.service.list({ category: 'RECEIVE_PACKAGE', status: 'PENDING', page: 1, size: 20 }, fullUser());
    expect(res.total).toBe(2); // mock 的 getManyAndCount 直接返回全集，重点断言过滤条件与信封
    expect(res.list).toHaveLength(2);
    expect(ctx.qb.andWhere).toHaveBeenCalledWith('r.category = :category', { category: 'RECEIVE_PACKAGE' });
    expect(ctx.qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: 'PENDING' });
    expect(res.list[0]).toMatchObject({ id: 'rec-1', category: 'RECEIVE_PACKAGE', status: 'PENDING' });
  });

  it('list 对缺少分类域权限的用户拒绝访问', async () => {
    const guest = { ...fullUser(), grants: {} } as unknown as AuthenticatedUser;
    await expect(ctx.service.list({ category: 'RECEIVE_PACKAGE' }, guest)).rejects.toMatchObject({
      code: 1003,
    });
  });

  it('create 落库并记录 createdBy / 默认状态', async () => {
    const res = await ctx.service.create(
      { category: 'TRANSFER', title: '移交包 B', bodyJson: { entries: 2 } },
      fullUser(),
    );
    expect(res).toMatchObject({ id: 'gen-1', category: 'TRANSFER', title: '移交包 B', status: 'DRAFT' });
    expect(ctx.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'user-1', bodyJson: { entries: 2 } }),
    );
  });

  it('update 修改标题与 JSON 载荷', async () => {
    ctx = setup([makeRow()]);
    const res = await ctx.service.update('rec-1', { title: '接收包 A（改）', bodyJson: { count: 5 } }, fullUser());
    expect(res.title).toBe('接收包 A（改）');
    expect(res.bodyJson).toEqual({ count: 5 });
  });

  it('action confirm 推进到 CONFIRMED', async () => {
    ctx = setup([makeRow()]);
    const res = await ctx.service.action('rec-1', { action: 'confirm' }, fullUser());
    expect(res.status).toBe('CONFIRMED');
    expect(res.action).toBe('confirm');
  });

  it('action check 返回四性检测演示结果并写入 bodyJson', async () => {
    ctx = setup([makeRow()]);
    const res = await ctx.service.action('rec-1', { action: 'check' }, fullUser());
    const result = res.checkResult;
    expect(result).toBeDefined();
    expect(result?.demo).toBe(true);
    for (const key of ['authenticity', 'integrity', 'availability', 'security'] as const) {
      expect(result?.[key]).toBeGreaterThanOrEqual(80);
      expect(result?.[key]).toBeLessThanOrEqual(100);
    }
    expect(result?.details).toHaveLength(4);
    expect(ctx.data[0].bodyJson.fourNature).toEqual(result);
  });

  it('action execute 推进状态并写业务审计', async () => {
    ctx = setup([makeRow({ category: 'ERMS_PACKAGE' })]);
    const res = await ctx.service.action('rec-1', { action: 'execute' }, fullUser());
    expect(res.status).toBe('COMPLETED');
    await vi.waitFor(() => expect(ctx.audit.append).toHaveBeenCalled());
    expect(ctx.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'BACKUP', objectType: 'ERMS_PACKAGE', objectId: 'rec-1' }),
    );
  });

  it('action publish / unpublish / inbound / outbound 状态流转', async () => {
    const cases: Array<[ExtensionActionDto['action'], string]> = [
      ['publish', 'PUBLISHED'],
      ['unpublish', 'DRAFT'],
      ['inbound', 'INSTOCK'],
      ['outbound', 'OUTSTOCK'],
    ];
    for (const [action, status] of cases) {
      ctx = setup([makeRow()]);
      const res = await ctx.service.action('rec-1', { action }, fullUser());
      expect(res.status).toBe(status);
    }
  });

  it('remove 删除记录', async () => {
    ctx = setup([makeRow()]);
    const res = await ctx.service.remove('rec-1', fullUser());
    expect(res.deleted).toBe(true);
    expect(ctx.data).toHaveLength(0);
  });

  it('不存在的记录抛 NOT_FOUND', async () => {
    await expect(ctx.service.remove('missing', fullUser())).rejects.toMatchObject({ code: 1004 });
  });
});
