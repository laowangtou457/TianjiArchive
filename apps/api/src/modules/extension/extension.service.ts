import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuditResult,
  BizException,
  ErrorCode,
  hasPermission,
  type OperationType,
  type PermissionDomain,
} from '@tianji/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ExtensionRecord } from '../../infra/database/entities/extension-record.entity';
import { AuditLogService } from '../audit/audit-log.service';

// ---------------------------------------------------------------------------
// 文件内 DTO（不改动 @tianji/shared 的 dto.ts）
// ---------------------------------------------------------------------------

export interface ExtensionRecordDto {
  id: string;
  category: string;
  title: string;
  bodyJson: Record<string, unknown>;
  status: string;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface ExtensionListResult {
  list: ExtensionRecordDto[];
  total: number;
}

export interface ExtensionRecordQuery {
  category?: string;
  status?: string;
  keyword?: string;
  page?: number | string;
  size?: number | string;
}

export interface CreateExtensionRecordDto {
  category: string;
  title: string;
  bodyJson?: Record<string, unknown>;
  status?: string;
  enabled?: boolean;
}

export interface UpdateExtensionRecordDto {
  category?: string;
  title?: string;
  bodyJson?: Record<string, unknown>;
  status?: string;
  enabled?: boolean;
}

export type ExtensionAction =
  | 'confirm'
  | 'reject'
  | 'publish'
  | 'unpublish'
  | 'execute'
  | 'check'
  | 'inbound'
  | 'outbound';

export interface ExtensionActionDto {
  action: ExtensionAction;
  bodyJson?: Record<string, unknown>;
}

/** 四性检测结果（前端标注「演示数据」） */
export interface FourNatureResult {
  authenticity: number;
  integrity: number;
  availability: number;
  security: number;
  demo: true;
  checkedAt: string;
  details: Array<{ name: string; ok: boolean; message: string }>;
}

export interface ExtensionActionResult extends ExtensionRecordDto {
  action: ExtensionAction;
  checkResult?: FourNatureResult;
}

/** category → 功能域映射（需求约定的权限口径） */
const CATEGORY_DOMAIN: Readonly<Record<string, PermissionDomain>> = {
  RECEIVE_PACKAGE: 'IMPORT_EXPORT',
  DATALINK_BATCH: 'IMPORT_EXPORT',
  TRANSFER: 'IMPORT_EXPORT',
  ERMS_PACKAGE: 'BACKUP',
  ERCHECK_ITEM: 'BACKUP',
  STOCK_ROOM: 'PARAM',
  STOCK_LOCATION: 'PARAM',
  AUX_ENTITY: 'PARAM',
  TEMPLATE: 'PARAM',
  METADATA: 'PARAM',
  CATEGORY_TEMPLATE: 'PARAM',
  NOTICE: 'PARAM',
  DOWNLOAD: 'PARAM',
  REPORT_DESIGN: 'PARAM',
  COMPILATION: 'COMPILATION',
  USAGE_LOG: 'AUDIT_LOG',
};

export function domainForCategory(category: string): PermissionDomain {
  const direct = CATEGORY_DOMAIN[category];
  if (direct) return direct;
  // 同一业务族的子分类（如 ERMS_PLAN / ERMS_TASK / ERMS_STORE）沿用族级功能域
  if (category.startsWith('ERMS') || category.startsWith('ERCHECK')) return 'BACKUP';
  if (category.startsWith('RECEIVE') || category.startsWith('DATALINK') || category.startsWith('TRANSFER')) return 'IMPORT_EXPORT';
  if (category.startsWith('COMPILATION')) return 'COMPILATION';
  if (category.startsWith('USAGE')) return 'AUDIT_LOG';
  return 'PARAM';
}

/** 动作 → 目标状态 */
const STATUS_BY_ACTION: Readonly<Record<ExtensionAction, string>> = {
  confirm: 'CONFIRMED',
  reject: 'REJECTED',
  publish: 'PUBLISHED',
  unpublish: 'DRAFT',
  execute: 'COMPLETED',
  check: 'CHECKED',
  inbound: 'INSTOCK',
  outbound: 'OUTSTOCK',
};

/** 审批类动作需要 APPROVE 权限，其余按 WRITE 校验 */
const APPROVE_ACTIONS: readonly ExtensionAction[] = [
  'confirm',
  'reject',
  'publish',
  'unpublish',
  'inbound',
  'outbound',
];

/**
 * 扩展功能通用服务。
 *
 * 所有配置/清单/单据型功能共用 extension_record 一张表，category 决定业务语义。
 * 权限按 category 动态映射到功能域（静态 @RequirePerm 只做入口基线校验，
 * 真正的分类域校验在这里基于记录 category 执行，避免「通用端点」成为越权旁路）。
 */
@Injectable()
export class ExtensionService {
  private readonly logger = new Logger(ExtensionService.name);

  constructor(
    @InjectRepository(ExtensionRecord)
    private readonly repo: Repository<ExtensionRecord>,
    private readonly audit: AuditLogService,
  ) {}

  /** 分页列表：category / status / keyword 过滤 */
  public async list(
    query: ExtensionRecordQuery,
    user: AuthenticatedUser | undefined,
  ): Promise<ExtensionListResult> {
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    if (category) this.assertPerm(user, category, 'READ');

    const page = Math.max(1, Number(query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(query.size) || 20));

    const qb = this.repo
      .createQueryBuilder('r')
      .orderBy('r.createdAt', 'DESC')
      .addOrderBy('r.id', 'DESC');
    if (category) qb.andWhere('r.category = :category', { category });
    if (query.status) qb.andWhere('r.status = :status', { status: query.status });
    if (query.keyword) qb.andWhere('r.title ILIKE :kw', { kw: `%${query.keyword}%` });
    qb.skip((page - 1) * size).take(size);

    const [rows, total] = await qb.getManyAndCount();
    return { list: rows.map((r) => this.toDto(r)), total };
  }

  /** 新建记录 */
  public async create(
    dto: CreateExtensionRecordDto,
    user: AuthenticatedUser | undefined,
  ): Promise<ExtensionRecordDto> {
    if (!dto.category || !dto.title) {
      throw new BizException(ErrorCode.BAD_REQUEST, 'category 与 title 不能为空');
    }
    this.assertPerm(user, dto.category, 'WRITE');

    const row = this.repo.create({
      category: dto.category,
      title: dto.title,
      bodyJson: dto.bodyJson ?? {},
      status: dto.status ?? 'DRAFT',
      enabled: dto.enabled ?? true,
      createdBy: user?.userId ?? null,
    });
    const saved = await this.repo.save(row);
    return this.toDto(saved);
  }

  /** 更新记录 */
  public async update(
    id: string,
    dto: UpdateExtensionRecordDto,
    user: AuthenticatedUser | undefined,
  ): Promise<ExtensionRecordDto> {
    const row = await this.findOrFail(id);
    this.assertPerm(user, row.category, 'WRITE');

    const patch: Partial<ExtensionRecord> = {};
    if (dto.category !== undefined && dto.category !== row.category) {
      this.assertPerm(user, dto.category, 'WRITE');
      patch.category = dto.category;
    }
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.bodyJson !== undefined) patch.bodyJson = dto.bodyJson;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    await this.repo.update(
      { id },
      patch as Parameters<Repository<ExtensionRecord>['update']>[1],
    );
    return this.toDto(await this.findOrFail(id));
  }

  /** 删除记录 */
  public async remove(
    id: string,
    user: AuthenticatedUser | undefined,
  ): Promise<{ deleted: boolean }> {
    const row = await this.findOrFail(id);
    this.assertPerm(user, row.category, 'DELETE');
    await this.repo.delete({ id });
    return { deleted: true };
  }

  /**
   * 状态流转 + 业务回调。
   * - execute：写一条业务审计（强制留痕）；
   * - check：返回四性检测模拟结果（前端标注「演示数据」）并写入 bodyJson；
   * - 其余动作：按 STATUS_BY_ACTION 推进状态。
   */
  public async action(
    id: string,
    dto: ExtensionActionDto,
    user: AuthenticatedUser | undefined,
  ): Promise<ExtensionActionResult> {
    const row = await this.findOrFail(id);
    const op: OperationType = APPROVE_ACTIONS.includes(dto.action) ? 'APPROVE' : 'WRITE';
    this.assertPerm(user, row.category, op);

    const status = STATUS_BY_ACTION[dto.action] ?? row.status;
    const bodyJson: Record<string, unknown> = {
      ...(row.bodyJson ?? {}),
      ...(dto.bodyJson ?? {}),
      lastAction: dto.action,
      actionAt: new Date().toISOString(),
    };

    let checkResult: FourNatureResult | undefined;
    if (dto.action === 'check') {
      checkResult = this.simulateFourNature(row);
      bodyJson.fourNature = checkResult;
    }

    await this.repo.update(
      { id },
      { status, bodyJson } as Parameters<Repository<ExtensionRecord>['update']>[1],
    );

    if (dto.action === 'execute') {
      void this.audit
        .append({
          userId: user?.userId ?? null,
          username: user?.username ?? null,
          action: domainForCategory(row.category) === 'BACKUP' ? 'BACKUP' : 'IMPORT',
          objectType: row.category,
          objectId: row.id,
          result: AuditResult.SUCCESS,
          ip: null,
          durationMs: null,
          detail: { action: dto.action, title: row.title },
        })
        .catch((err: unknown) => {
          this.logger.warn(`扩展功能 execute 审计写入失败: ${(err as Error)?.message ?? String(err)}`);
        });
    }

    const updated = await this.findOrFail(id);
    return {
      ...this.toDto(updated),
      action: dto.action,
      ...(checkResult ? { checkResult } : {}),
    };
  }

  /** 按 category 动态校验功能域权限 */
  private assertPerm(
    user: AuthenticatedUser | undefined,
    category: string,
    op: OperationType,
  ): void {
    const domain = domainForCategory(category);
    if (!user || !hasPermission(user, domain, op)) {
      throw new BizException(
        ErrorCode.FORBIDDEN,
        `无权限执行该操作（功能域 ${domain} / 操作 ${op}）`,
      );
    }
  }

  private async findOrFail(id: string): Promise<ExtensionRecord> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '记录不存在');
    return row;
  }

  /** 四性检测演示结果：确定性伪随机，保证同一记录多次展示一致 */
  private simulateFourNature(row: ExtensionRecord): FourNatureResult {
    const seed = [...row.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const score = (base: number): number => Math.min(100, base + (seed % 7));
    return {
      authenticity: score(93),
      integrity: score(95),
      availability: score(91),
      security: score(94),
      demo: true,
      checkedAt: new Date().toISOString(),
      details: [
        { name: '真实性', ok: true, message: '元数据签名链与来源标识校验通过（演示数据）' },
        { name: '完整性', ok: true, message: '条目数量与校验和一致（演示数据）' },
        { name: '可用性', ok: true, message: '格式可解析、载体可读取（演示数据）' },
        { name: '安全性', ok: true, message: '密级标识与访问控制策略齐备（演示数据）' },
      ],
    };
  }

  private toDto(row: ExtensionRecord): ExtensionRecordDto {
    return {
      id: row.id,
      category: row.category,
      title: row.title,
      bodyJson: row.bodyJson ?? {},
      status: row.status,
      enabled: row.enabled,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}
