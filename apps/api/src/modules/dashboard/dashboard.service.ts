import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BorrowStatus,
  hasPermission,
  type DashboardStats,
  type DashboardSummary,
  type DashboardTodo,
  type PermissionSnapshot,
} from '@tianji/shared';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { BorrowOrder } from '../../infra/database/entities/borrow-order.entity';
import { SearchHistory } from '../../infra/database/entities/search-history.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';

/**
 * 工作台汇总服务（F-13）。
 *
 * 口径：
 *   - 「待著录」= 授权范围内 DRAFT 状态条目数；
 *   - 「待审批借阅」= 具备审批权时全库 PENDING 数，否则 0；
 *   - 「待归还」= 本人 LENT/OVERDUE 数；
 *   - 「鉴定到期」P1 预留，P0 恒为 0；
 *   - 库存/入库趋势/借阅 Top/最近检索均按权限过滤。
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  public constructor(
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Volume) private readonly volumeRepo: Repository<Volume>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(ElectronicFile) private readonly fileRepo: Repository<ElectronicFile>,
    @InjectRepository(BorrowOrder) private readonly orderRepo: Repository<BorrowOrder>,
    @InjectRepository(SearchHistory) private readonly historyRepo: Repository<SearchHistory>,
    private readonly accessBuilder: AccessFilterBuilder,
  ) {}

  /** 工作台汇总 */
  public async summary(user: PermissionSnapshot): Promise<DashboardSummary> {
    const { clause, params } = this.accessBuilder.buildSql(user, 'i', { startIndex: 1 });

    // 1) 库存
    const stockRows = (await this.itemRepo.query(
      `SELECT COUNT(*)::int AS items,
              COALESCE(SUM(f.cnt), 0)::int AS files,
              COALESCE(SUM(f.bytes), 0)::bigint AS bytes
         FROM archive_item i
         LEFT JOIN (SELECT item_id, COUNT(*)::int AS cnt, COALESCE(SUM(size),0)::bigint AS bytes
                      FROM electronic_file GROUP BY item_id) f ON f.item_id = i.id
        WHERE ${clause}`,
      params,
    )) as Array<{ items: number; files: number; bytes: string }>;

    const totalItems = Number(stockRows[0]?.items ?? 0);
    const totalFiles = Number(stockRows[0]?.files ?? 0);
    const totalBytes = Number(stockRows[0]?.bytes ?? 0);
    const totalFonds = await this.fondsRepo.count();

    // 2) 待著录（草稿）
    const pendingRows = (await this.itemRepo.query(
      `SELECT COUNT(*)::int AS c FROM archive_item i WHERE ${clause} AND i.status = 'DRAFT'`,
      params,
    )) as Array<{ c: number }>;
    const pendingCatalog = Number(pendingRows[0]?.c ?? 0);

    // 3) 借阅相关
    const pendingReturn = await this.orderRepo.count({
      where: {
        applicantId: user.userId,
        status: In([BorrowStatus.LENT, BorrowStatus.OVERDUE]),
      },
    });
    const canApprove = this.accessBuilder.levelsAtMost(user.maxSecurityLevel).length > 0;
    const pendingApproval = canApprove
      ? await this.orderRepo.count({ where: { status: BorrowStatus.PENDING } })
      : 0;

    // 4) 近 6 个月入库趋势
    const intakeRows = (await this.itemRepo.query(
      `SELECT to_char(i.created_at, 'YYYY-MM') AS month, COUNT(*)::int AS cnt
         FROM archive_item i
        WHERE ${clause} AND i.created_at >= now() - interval '6 months'
        GROUP BY month ORDER BY month ASC`,
      params,
    )) as Array<{ month: string; cnt: number }>;
    const intakeByMonth = (intakeRows ?? []).map((r) => ({
      month: r.month,
      itemCount: Number(r.cnt),
    }));

    // 5) 借阅 Top5
    const topRaw = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.item_id', 'itemId')
      .addSelect('COUNT(*)::int', 'cnt')
      .groupBy('o.item_id')
      .orderBy('cnt', 'DESC')
      .limit(5)
      .getRawMany<{ itemId: string; cnt: string }>();
    const ids = topRaw.map((r) => r.itemId);
    const itemRows = ids.length
      ? await this.itemRepo.find({ where: { id: In(ids) }, select: ['id', 'danghao', 'title'] })
      : [];
    const itemMap = new Map(itemRows.map((i) => [i.id, i]));
    const borrowTopItems = topRaw.map((r) => ({
      danghao: itemMap.get(r.itemId)?.danghao ?? '',
      title: itemMap.get(r.itemId)?.title ?? '',
      count: Number(r.cnt),
    }));

    // 6) 最近检索（本人）
    const recentRows = await this.historyRepo.find({
      where: { userId: user.userId },
      order: { createdAt: 'DESC' },
      take: 8,
    });
    const recentSearches: string[] = [
      ...new Set(recentRows.map((r) => r.keyword).filter((k): k is string => Boolean(k))),
    ];

    return {
      pendingCatalog,
      pendingApproval,
      pendingReturn,
      appraisalDue: 0,
      stock: { totalItems, totalFiles, totalBytes, totalFonds },
      intakeByMonth,
      borrowTopItems,
      recentSearches,
    };
  }

  /** ISO 时间：空值用当前时间，避免前端展示 Invalid Date */
  private iso(value: Date | string | null | undefined): string {
    if (!value) return new Date().toISOString();
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  /**
   * 逐条待办事项（对齐泰坦首页「待办事项」）。
   * 全部按当前用户的角色 / 功能域 / 数据范围过滤，条目可直接跳转处理。
   */
  public async todos(user: PermissionSnapshot): Promise<DashboardTodo[]> {
    const todos: DashboardTodo[] = [];
    const roles: string[] = user.roles.length ? [...user.roles] : ['__none__'];

    // 1) 待著录草稿（授权范围内）
    if (hasPermission(user, 'ITEM', 'WRITE')) {
      const { clause, params } = this.accessBuilder.buildSql(user, 'i', { startIndex: 1 });
      const rows = (await this.itemRepo.query(
        `SELECT COUNT(*)::int AS c, MAX(i.created_at) AS ts
           FROM archive_item i
          WHERE ${clause} AND i.status = 'DRAFT'`,
        params,
      )) as Array<{ c: number; ts: Date | string | null }>;
      const count = Number(rows[0]?.c ?? 0);
      if (count > 0) {
        todos.push({
          id: 'catalog-draft',
          category: 'CATALOG',
          title: `待著录草稿 ${count} 件`,
          detail: '授权范围内存在未著录完成的条目，请进入档案著录处理',
          timestamp: this.iso(rows[0]?.ts),
          path: '/catalog',
          level: 'medium',
          count,
        });
      }
    }

    // 2) 借阅待审批
    if (hasPermission(user, 'BORROW_APPROVE', 'APPROVE')) {
      const rows = (await this.itemRepo.query(
        `SELECT COUNT(*)::int AS c, MAX(created_at) AS ts
           FROM borrow_order WHERE status = 'PENDING'`,
      )) as Array<{ c: number; ts: Date | string | null }>;
      const count = Number(rows[0]?.c ?? 0);
      if (count > 0) {
        todos.push({
          id: 'borrow-approval',
          category: 'BORROW',
          title: `借阅待审批 ${count} 单`,
          detail: '有待审批的借阅申请，请在借阅管理「待我审批」中处理',
          timestamp: this.iso(rows[0]?.ts),
          path: '/borrow',
          level: 'high',
          count,
        });
      }
    }

    // 3) 审批中心我的待办（按环节角色派单，岗位待办池）
    const taskRows = (await this.itemRepo.query(
      `SELECT t.id, t.node_name, t.created_at, i.title, i.biz_type
         FROM workflow_task t
         JOIN workflow_instance i ON i.id = t.instance_id
        WHERE t.status = 'PENDING'
          AND (t.role_code = '*' OR t.role_code = ANY($1::varchar[]))
        ORDER BY t.created_at ASC
        LIMIT 10`,
      [roles],
    )) as Array<{ id: string; node_name: string; created_at: Date | string; title: string; biz_type: string }>;
    for (const r of taskRows) {
      todos.push({
        id: `workflow-${r.id}`,
        category: 'WORKFLOW',
        title: `${r.node_name || '审批环节'}：${r.title || r.biz_type || '审批事项'}`,
        detail: '审批中心有流转到您岗位的待办',
        timestamp: this.iso(r.created_at),
        path: '/workflow',
        level: 'high',
        count: 1,
      });
    }

    // 4) 我的待归还 / 已逾期
    if (hasPermission(user, 'BORROW_APPLY', 'READ')) {
      const rows = (await this.itemRepo.query(
        `SELECT COUNT(*)::int AS c, MAX(created_at) AS ts
           FROM borrow_order
          WHERE applicant_id = $1 AND status IN ('LENT', 'OVERDUE')`,
        [user.userId],
      )) as Array<{ c: number; ts: Date | string | null }>;
      const count = Number(rows[0]?.c ?? 0);
      if (count > 0) {
        todos.push({
          id: 'borrow-return',
          category: 'BORROW',
          title: `我的待归还 ${count} 件`,
          detail: '借出中的档案即将到期或已逾期，请联系档案管理员办理归还',
          timestamp: this.iso(rows[0]?.ts),
          path: '/borrow',
          level: 'medium',
          count,
        });
      }
    }

    // 5) 鉴定任务进行中
    if (hasPermission(user, 'APPRAISAL', 'READ')) {
      const rows = (await this.itemRepo.query(
        `SELECT COUNT(*)::int AS c, MAX(created_at) AS ts
           FROM appraisal_task WHERE status IN ('DRAFT', 'IN_PROGRESS')`,
      )) as Array<{ c: number; ts: Date | string | null }>;
      const count = Number(rows[0]?.c ?? 0);
      if (count > 0) {
        todos.push({
          id: 'appraisal-task',
          category: 'APPRAISAL',
          title: `鉴定任务进行中 ${count} 个`,
          detail: '存在未完成的鉴定任务，请给明细结论并执行',
          timestamp: this.iso(rows[0]?.ts),
          path: '/appraisal',
          level: 'medium',
          count,
        });
      }
    }

    // 6) 失败备份（对齐泰坦「需要手工执行完全备份的任务」）
    if (hasPermission(user, 'BACKUP', 'READ')) {
      const rows = (await this.itemRepo.query(
        `SELECT id, filename, started_at
           FROM backup_record WHERE status = 'FAILED'
          ORDER BY started_at DESC LIMIT 3`,
      )) as Array<{ id: string; filename: string; started_at: Date | string }>;
      for (const r of rows) {
        todos.push({
          id: `backup-${r.id}`,
          category: 'BACKUP',
          title: `备份失败需手工处理：${r.filename}`,
          detail: '系统检测到失败的备份任务，请到备份恢复页核查并重新执行',
          timestamp: this.iso(r.started_at),
          path: '/backup',
          level: 'high',
          count: 1,
        });
      }
    }

    // 7) 回收站临期提醒
    if (hasPermission(user, 'RECYCLE', 'READ')) {
      const rows = (await this.itemRepo.query(
        `SELECT COUNT(*)::int AS c, MAX(deleted_at) AS ts
           FROM recycle_bin WHERE purge_after <= now() + interval '7 days'`,
      )) as Array<{ c: number; ts: Date | string | null }>;
      const count = Number(rows[0]?.c ?? 0);
      if (count > 0) {
        todos.push({
          id: 'recycle-expiring',
          category: 'RECYCLE',
          title: `回收站临期 ${count} 件`,
          detail: '7 天内将被物理清理，如需还原请尽快处理',
          timestamp: this.iso(rows[0]?.ts),
          path: '/recycle',
          level: 'low',
          count,
        });
      }
    }

    const weight = { high: 0, medium: 1, low: 2 } as const;
    return todos.sort((a, b) => {
      const byLevel = weight[a.level] - weight[b.level];
      if (byLevel !== 0) return byLevel;
      return b.timestamp.localeCompare(a.timestamp);
    });
  }

  /** 数据统计四个页签（对齐泰坦首页「数据统计」） */
  public async stats(user: PermissionSnapshot): Promise<DashboardStats> {
    const { clause, params } = this.accessBuilder.buildSql(user, 'i', { startIndex: 1 });

    // 档案统计：按业务阶段映射泰坦的四个口径
    const archiveRows = (await this.itemRepo.query(
      `SELECT COUNT(*) FILTER (WHERE i.status IN ('DRAFT','PRE_ARCHIVED','SUBMITTED'))::int AS uncollected,
              COUNT(*) FILTER (WHERE i.status = 'ARCHIVED')::int AS archived,
              COUNT(DISTINCT i.volume_id)::int AS volumes,
              COUNT(*) FILTER (WHERE i.category_code IS NOT NULL)::int AS categorized
         FROM archive_item i
        WHERE ${clause}`,
      params,
    )) as Array<{ uncollected: number; archived: number; volumes: number; categorized: number }>;
    const a = archiveRows[0];
    const archive = [
      { name: '未归收集', value: Number(a?.uncollected ?? 0) },
      { name: '归档管理', value: Number(a?.archived ?? 0) },
      { name: '案卷管理', value: Number(a?.volumes ?? 0) },
      { name: '资料管理', value: Number(a?.categorized ?? 0) },
    ];

    // 原文统计：按电子文件抽取状态，另算「无电子文件」的条目
    const extractRows = (await this.itemRepo.query(
      `SELECT COALESCE(f.extract_status, 'PENDING') AS s, COUNT(*)::int AS c
         FROM electronic_file f
         JOIN archive_item i ON i.id = f.item_id
        WHERE ${clause}
        GROUP BY s`,
      params,
    )) as Array<{ s: string; c: number }>;
    const extractMap = new Map(extractRows.map((r) => [r.s, Number(r.c)]));
    const withFile = extractRows.reduce((sum, r) => sum + Number(r.c), 0);
    const totalRows = (await this.itemRepo.query(
      `SELECT COUNT(*)::int AS c FROM archive_item i WHERE ${clause}`,
      params,
    )) as Array<{ c: number }>;
    const fulltext = [
      { name: '已抽取', value: extractMap.get('OK') ?? 0 },
      { name: '待抽取', value: extractMap.get('PENDING') ?? 0 },
      { name: '抽取失败', value: extractMap.get('FAILED') ?? 0 },
      { name: '无电子文件', value: Math.max(Number(totalRows[0]?.c ?? 0) - withFile, 0) },
    ];

    // 利用统计（近 30 天，按审计动作）
    const usageRows = (await this.itemRepo.query(
      `SELECT action AS s, COUNT(*)::int AS c
         FROM audit_log
        WHERE created_at >= now() - interval '30 days'
          AND (action IN ('SEARCH','PREVIEW','DOWNLOAD')
               OR (action = 'CREATE' AND object_type = 'BORROW_ORDER'))
        GROUP BY action`,
    )) as Array<{ s: string; c: number }>;
    const usageMap = new Map(usageRows.map((r) => [r.s, Number(r.c)]));
    const usage = [
      { name: '检索', value: usageMap.get('SEARCH') ?? 0 },
      { name: '预览', value: usageMap.get('PREVIEW') ?? 0 },
      { name: '下载', value: usageMap.get('DOWNLOAD') ?? 0 },
      { name: '借阅', value: usageMap.get('CREATE') ?? 0 },
    ];

    // 最近一周登录（补零，含今天）
    const loginRows = (await this.itemRepo.query(
      `SELECT to_char(d.day, 'MM-DD') AS name, COUNT(a.id)::int AS value
         FROM generate_series(current_date - interval '6 days', current_date, interval '1 day') AS d(day)
         LEFT JOIN audit_log a
                ON a.action = 'LOGIN'
               AND a.created_at >= d.day
               AND a.created_at < d.day + interval '1 day'
        GROUP BY d.day
        ORDER BY d.day ASC`,
    )) as Array<{ name: string; value: number }>;

    return { archive, fulltext, usage, login: loginRows.map((r) => ({ name: r.name, value: Number(r.value) })) };
  }
}
