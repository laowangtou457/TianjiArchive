import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BorrowStatus,
  type DashboardSummary,
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
}
