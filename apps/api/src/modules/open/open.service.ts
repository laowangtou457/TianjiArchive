import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  OPEN_DECISION_SCOPE,
  OPEN_SCOPE_LABELS,
  WorkflowBizType,
  WorkflowCallback,
  type CreateOpenBatchDto,
  type OpenApplyResult,
  type OpenBatchDto,
  type OpenDecision,
  type OpenReviewDto,
  type PermissionSnapshot,
  type ReviewOpenBatchDto,
  type SecurityLevel,
} from '@tianji/shared';
import { OpenBatch } from '../../infra/database/entities/open-batch.entity';
import { OpenReview } from '../../infra/database/entities/open-review.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { EsIndexerService } from '../../infra/elasticsearch/es-indexer.service';
import { WorkflowService } from '../workflow/workflow.service';

const MAX_REVIEWS_PER_BATCH = 20000;
const BATCH_LIMIT = 500;

export interface OpenBatchQuery {
  status?: string;
  keyword?: string;
  fondsId?: string;
  page?: number;
  size?: number;
}

export interface OpenReviewQuery {
  decision?: string;
  keyword?: string;
  page?: number;
  size?: number;
}

/**
 * 开放管理（F-19，对齐泰坦「未处理 → 条目开放 / 原文开放 / 不开放 / 再审查 + 开放批次」）。
 *
 * ## 两阶段：审核 → 审批 → 应用
 *
 *   IN_PROGRESS  逐件给结论（可反复改）
 *   APPROVING    提交审批流（此时明细锁定，避免「审批看到的」和「实际应用的」不一致）
 *   FINISHED     审批通过后统一写 archive_item.open_scope / open_flag
 *
 * ## 为什么应用要单独一步
 *
 * 开放是**对外生效**的政策动作：审批通过后可能还要挑时间统一发布（如国际档案日）。
 * 把「决定开放」与「对外生效」解耦，既留出发布窗口，也让 appliedAt 有独立时间戳，
 * 事后能回答「这件是哪天真正开放的」。
 *
 * ## 再审查（REREVIEW）不是终态
 *
 * 存疑件不进任何开放标识，留在再审查队列等待补充依据；
 * 再次审核需**新建批次**（与泰坦一致）——同一件在同一批次里只允许一个结论，
 * 否则「上次为什么不开放」会被覆盖。
 */
@Injectable()
export class OpenService implements OnModuleInit {
  private readonly logger = new Logger(OpenService.name);

  constructor(
    @InjectRepository(OpenBatch) private readonly batchRepo: Repository<OpenBatch>,
    @InjectRepository(OpenReview) private readonly reviewRepo: Repository<OpenReview>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(AppUser) private readonly userRepo: Repository<AppUser>,
    private readonly dataSource: DataSource,
    private readonly esIndexer: EsIndexerService,
    private readonly workflow: WorkflowService,
  ) {}

  public onModuleInit(): void {
    // 审批通过 → 应用开放标识（幂等：applied_at 为空的明细才会被处理）
    this.workflow.registerCallback(WorkflowCallback.OPEN_BATCH_APPLY, async (instance) => {
      await this.applyBatch(instance.bizId, instance.initiatorId);
    });
  }

  // ==========================================================================
  // 批次
  // ==========================================================================

  public async list(
    query: OpenBatchQuery,
    user?: PermissionSnapshot,
  ): Promise<{ items: OpenBatchDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(query.size ?? 20)));

    const qb = this.batchRepo.createQueryBuilder('b');
    if (query.status) qb.andWhere('b.status = :st', { st: query.status });
    if (query.fondsId) qb.andWhere('b.fonds_id = :fid', { fid: query.fondsId });
    if (query.keyword) {
      qb.andWhere('(b.name ILIKE :kw OR b.batch_no ILIKE :kw)', { kw: `%${query.keyword}%` });
    }
    if (user && user.fondsIds !== null) {
      const ids = user.fondsIds.length ? user.fondsIds : ['00000000-0000-0000-0000-000000000000'];
      qb.andWhere('b.fonds_id = ANY(:fondsIds)', { fondsIds: ids });
    }
    qb.orderBy('b.created_at', 'DESC')
      .skip((page - 1) * size)
      .take(size);
    const [rows, total] = await qb.getManyAndCount();
    return { items: await this.buildDtos(rows), total, page, size };
  }

  public async detail(id: string): Promise<OpenBatchDto> {
    const row = await this.batchRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '开放批次不存在');
    const [dto] = await this.buildDtos([row]);
    return dto;
  }

  /** 新建批次并生成待审明细 */
  public async create(dto: CreateOpenBatchDto, user: PermissionSnapshot): Promise<OpenBatchDto> {
    if (!dto.name?.trim()) throw new BizException(ErrorCode.BAD_REQUEST, '批次名称不能为空');
    if (dto.yearFrom != null && dto.yearTo != null && dto.yearFrom > dto.yearTo) {
      throw new BizException(ErrorCode.BAD_REQUEST, '起始年度不能大于结束年度');
    }

    const seqRow: Array<{ v: string }> = await this.dataSource.query(
      `SELECT nextval('seq_open_batch_no')::text AS v`,
    );
    const batchNo = `KF${new Date().getFullYear()}-${String(seqRow[0]?.v ?? '1').padStart(3, '0')}`;

    const batch = await this.batchRepo.save(
      this.batchRepo.create({
        batchNo,
        name: dto.name.trim(),
        status: 'DRAFT',
        fondsId: dto.fondsId ?? null,
        yearFrom: dto.yearFrom ?? null,
        yearTo: dto.yearTo ?? null,
        securityLevels: dto.securityLevels ?? [],
        createdBy: user.userId,
      }),
    );
    const generated = await this.generateReviews(batch.id, dto.unopenedOnly !== false);
    await this.batchRepo.update({ id: batch.id }, { total: generated, status: 'IN_PROGRESS' });
    this.logger.log(`开放批次 ${batchNo} 生成待审明细 ${generated} 件`);
    return this.detail(batch.id);
  }

  public async cancel(id: string, user: PermissionSnapshot): Promise<OpenBatchDto> {
    const batch = await this.batchRepo.findOne({ where: { id } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '开放批次不存在');
    if (batch.status === 'FINISHED') {
      throw new BizException(ErrorCode.CONFLICT, '已开放的批次不能作废');
    }
    await this.batchRepo.update({ id }, { status: 'CANCELLED', updatedAt: new Date() });
    this.logger.log(`开放批次 ${batch.batchNo} 由 ${user.username} 作废`);
    return this.detail(id);
  }

  // ==========================================================================
  // 明细审核
  // ==========================================================================

  public async listReviews(
    batchId: string,
    query: OpenReviewQuery,
  ): Promise<{ items: OpenReviewDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(200, Math.max(1, Number(query.size ?? 20)));

    const qb = this.reviewRepo.createQueryBuilder('r').where('r.batch_id = :batchId', { batchId });
    if (query.decision) qb.andWhere('r.decision = :d', { d: query.decision });
    if (query.keyword) {
      qb.andWhere('(r.danghao ILIKE :kw OR r.title ILIKE :kw)', { kw: `%${query.keyword}%` });
    }
    qb.orderBy('r.danghao', 'ASC')
      .skip((page - 1) * size)
      .take(size);
    const [rows, total] = await qb.getManyAndCount();
    const names = await this.userNameMap(rows.map((r) => r.reviewerId));
    return {
      items: rows.map((r) => this.toReviewDto(r, names)),
      total,
      page,
      size,
    };
  }

  /** 跨批次的再审查队列 */
  public async rereviewQueue(
    query: { keyword?: string; page?: number; size?: number },
  ): Promise<{ items: OpenReviewDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(200, Math.max(1, Number(query.size ?? 20)));
    const qb = this.reviewRepo
      .createQueryBuilder('r')
      .where(`r.decision = 'REREVIEW'`)
      .andWhere('r.applied_at IS NULL');
    if (query.keyword) {
      qb.andWhere('(r.danghao ILIKE :kw OR r.title ILIKE :kw)', { kw: `%${query.keyword}%` });
    }
    qb.orderBy('r.reviewed_at', 'DESC')
      .skip((page - 1) * size)
      .take(size);
    const [rows, total] = await qb.getManyAndCount();
    const names = await this.userNameMap(rows.map((r) => r.reviewerId));
    return { items: rows.map((r) => this.toReviewDto(r, names)), total, page, size };
  }

  /**
   * 提交审核结论（批量）。
   * APPROVING 状态下拒绝再改：审批看到的必须是最终结论。
   */
  public async review(
    batchId: string,
    dto: ReviewOpenBatchDto,
    user: PermissionSnapshot,
  ): Promise<{ updated: number }> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '开放批次不存在');
    if (batch.status === 'APPROVING') {
      throw new BizException(ErrorCode.CONFLICT, '批次已提交审批，不能修改结论；如需调整请撤回审批');
    }
    if (batch.status === 'FINISHED' || batch.status === 'CANCELLED') {
      throw new BizException(ErrorCode.CONFLICT, '已开放/已作废的批次不能修改结论');
    }
    const ids = Array.isArray(dto.ids) ? dto.ids : [];
    if (ids.length === 0) throw new BizException(ErrorCode.BAD_REQUEST, '请选择要审核的条目');
    if (ids.length > BATCH_LIMIT) {
      throw new BizException(ErrorCode.BAD_REQUEST, `单次审核不得超过 ${BATCH_LIMIT} 条`);
    }
    if (!OPEN_DECISION_SCOPE[dto.decision] && dto.decision !== 'REREVIEW') {
      throw new BizException(ErrorCode.BAD_REQUEST, '审核结论不合法');
    }
    const reason = dto.reason?.trim() || null;
    if ((dto.decision === 'DENY' || dto.decision === 'REREVIEW') && !reason) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        dto.decision === 'DENY' ? '「不开放」必须填写理由' : '「再审查」必须填写存疑原因',
      );
    }

    const res = await this.reviewRepo
      .createQueryBuilder()
      .update(OpenReview)
      .set({
        decision: dto.decision,
        reason,
        reviewerId: user.userId,
        reviewedAt: new Date(),
      })
      .where('batch_id = :batchId AND id IN (:...ids) AND applied_at IS NULL', { batchId, ids })
      .execute();

    await this.batchRepo.update({ id: batchId }, { status: 'IN_PROGRESS', updatedAt: new Date() });
    return { updated: res.affected ?? 0 };
  }

  /** 提交审批（要求明细无「未处理」，否则审批无法判断总量） */
  public async submit(batchId: string, user: PermissionSnapshot): Promise<OpenBatchDto> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '开放批次不存在');
    if (batch.status === 'FINISHED' || batch.status === 'CANCELLED') {
      throw new BizException(ErrorCode.CONFLICT, '已开放/已作废的批次不能提交审批');
    }
    // 未审核件一律按「不开放」收口（fail-closed）：目录开放是授权扩大，
    // 不能因为「忘了审」而默许开放。这样也避免了「几千件必须逐件点完才能提交」的死锁，
    // 剩下的件可留到下一批次重审，且 reason 里写清了原因可追溯。
    const pending = await this.reviewRepo.count({ where: { batchId, decision: 'PENDING' } });
    if (pending > 0) {
      await this.reviewRepo
        .createQueryBuilder()
        .update(OpenReview)
        .set({
          decision: 'DENY',
          reason: '批次提交时未审核，默认控制使用（可留待下一批次重审）',
          reviewedAt: new Date(),
        })
        .where('batch_id = :batchId AND decision = \'PENDING\'', { batchId })
        .execute();
      this.logger.warn(`开放批次 ${batch.batchNo}：${pending} 件未审核，已按「不开放」收口`);
    }
    const existing = await this.workflow.findForBiz(WorkflowBizType.OPEN_BATCH, batchId);
    if (existing && existing.status === 'RUNNING') {
      throw new BizException(ErrorCode.CONFLICT, '该批次审批已在流转中');
    }

    const stat = await this.decisionStats(batchId);
    const inst = await this.workflow.start(
      {
        bizType: WorkflowBizType.OPEN_BATCH,
        bizId: batchId,
        title: `开放批次审批：${batch.name}`,
        summary: `共 ${batch.total} 件：条目开放 ${stat.openedEntry}、原文开放 ${stat.openedFulltext}、不开放 ${stat.denied}、再审查 ${stat.rereview}`,
        payload: { batchNo: batch.batchNo, ...stat },
      },
      user,
    );
    await this.batchRepo.update(
      { id: batchId },
      { status: 'APPROVING', workflowInstanceId: inst.id, updatedAt: new Date() },
    );
    return this.detail(batchId);
  }

  /**
   * 应用开放标识（回调入口 + 管理员手动重试入口）。
   *
   * 幂等：只处理 applied_at IS NULL 且结论明确的明细；重复调用不会重复写库，
   * 因此「回调失败后人工重放」是安全的。
   */
  public async applyBatch(batchId: string, operatorId: string | null): Promise<OpenApplyResult> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '开放批次不存在');

    const rows = await this.reviewRepo.find({
      where: {
        batchId,
        appliedAt: IsNull(),
        decision: In(['OPEN_ENTRY', 'OPEN_FULLTEXT', 'DENY']),
      },
    });
    const result: OpenApplyResult = {
      applied: 0,
      openedEntry: 0,
      openedFulltext: 0,
      denied: 0,
      failed: [],
    };
    if (rows.length === 0) {
      await this.finishBatch(batchId, operatorId);
      return result;
    }

    const now = new Date();
    const touched: string[] = [];
    for (const row of rows) {
      const scope = OPEN_DECISION_SCOPE[row.decision];
      if (!scope) continue;
      try {
        const openFlag = scope === 'NONE' ? 'CONTROLLED' : 'OPEN';
        await this.itemRepo.update(
          { id: row.itemId },
          { openScope: scope, openFlag, updatedAt: now } as never,
        );
        await this.reviewRepo.update({ id: row.id }, { appliedAt: now });
        touched.push(row.itemId);
        result.applied += 1;
        if (row.decision === 'OPEN_ENTRY') result.openedEntry += 1;
        if (row.decision === 'OPEN_FULLTEXT') result.openedFulltext += 1;
        if (row.decision === 'DENY') result.denied += 1;
      } catch (err) {
        result.failed.push({ id: row.itemId, reason: (err as Error).message });
      }
    }
    if (touched.length > 0) this.esIndexer.enqueueMany(touched);
    await this.finishBatch(batchId, operatorId);
    this.logger.log(
      `开放批次 ${batch.batchNo} 应用完成：${OPEN_SCOPE_LABELS.ENTRY} ${result.openedEntry} / ${OPEN_SCOPE_LABELS.FULLTEXT} ${result.openedFulltext} / 不开放 ${result.denied}`,
    );
    return result;
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private async finishBatch(batchId: string, _operatorId: string | null): Promise<void> {
    await this.batchRepo.update(
      { id: batchId },
      { status: 'FINISHED', finishedAt: new Date(), updatedAt: new Date() },
    );
  }

  /** 生成待审明细（含密级上限过滤：超出审核人密级范围的件不进批次） */
  private async generateReviews(batchId: string, unopenedOnly: boolean): Promise<number> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '开放批次不存在');

    const params: unknown[] = [batchId];
    let idx = 2;
    const clauses: string[] = [`i.deleted = FALSE`, `i.status = 'ARCHIVED'`];
    if (batch.fondsId) {
      clauses.push(`i.fonds_id = $${idx}`);
      params.push(batch.fondsId);
      idx += 1;
    }
    if (batch.yearFrom != null) {
      clauses.push(`i.year >= $${idx}`);
      params.push(batch.yearFrom);
      idx += 1;
    }
    if (batch.yearTo != null) {
      clauses.push(`i.year <= $${idx}`);
      params.push(batch.yearTo);
      idx += 1;
    }
    if (Array.isArray(batch.securityLevels) && batch.securityLevels.length > 0) {
      clauses.push(`i.security_level = ANY($${idx}::varchar[])`);
      params.push(batch.securityLevels);
      idx += 1;
    }
    if (unopenedOnly) {
      clauses.push(`i.open_scope = 'NONE'`);
    }

    const inserted: Array<{ c: string }> = await this.dataSource.query(
      `WITH picked AS (
         SELECT i.id, i.danghao, i.title, i.year, i.security_level
         FROM archive_item i
         WHERE ${clauses.join(' AND ')}
         ORDER BY i.danghao
         LIMIT ${MAX_REVIEWS_PER_BATCH}
       ), ins AS (
         INSERT INTO open_review (batch_id, item_id, danghao, title, year, security_level, decision)
         SELECT $1::uuid, p.id, p.danghao, p.title, p.year, p.security_level, 'PENDING'
         FROM picked p
         ON CONFLICT (batch_id, item_id) DO NOTHING
         RETURNING 1
       )
       SELECT COUNT(*)::text AS c FROM ins`,
      params,
    );
    return Number.parseInt(inserted[0]?.c ?? '0', 10);
  }

  private async buildDtos(rows: OpenBatch[]): Promise<OpenBatchDto[]> {
    if (rows.length === 0) return [];
    const [stats, fondsMap, userMap, wfMap] = await Promise.all([
      this.statsMap(rows.map((r) => r.id)),
      this.fondsNameMap(rows.map((r) => r.fondsId)),
      this.userNameMap(rows.map((r) => r.createdBy)),
      this.workflowStatusMap(rows.map((r) => r.id)),
    ]);
    return rows.map((r) => {
      const s = stats.get(r.id);
      return {
        id: r.id,
        batchNo: r.batchNo,
        name: r.name,
        status: r.status,
        fondsId: r.fondsId,
        fondsName: r.fondsId ? (fondsMap.get(r.fondsId) ?? null) : null,
        yearFrom: r.yearFrom,
        yearTo: r.yearTo,
        securityLevels: (r.securityLevels ?? []) as SecurityLevel[],
        total: r.total,
        pending: s?.pending ?? 0,
        openedEntry: s?.openedEntry ?? 0,
        openedFulltext: s?.openedFulltext ?? 0,
        denied: s?.denied ?? 0,
        rereview: s?.rereview ?? 0,
        workflowInstanceId: r.workflowInstanceId,
        workflowStatus: wfMap.get(r.id) ?? null,
        createdBy: r.createdBy,
        createdByName: r.createdBy ? (userMap.get(r.createdBy) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      };
    });
  }

  private async statsMap(batchIds: string[]): Promise<
    Map<
      string,
      { pending: number; openedEntry: number; openedFulltext: number; denied: number; rereview: number }
    >
  > {
    const map = new Map<
      string,
      { pending: number; openedEntry: number; openedFulltext: number; denied: number; rereview: number }
    >();
    if (batchIds.length === 0) return map;
    const rows: Array<{ batch_id: string; decision: string; c: string }> = await this.dataSource.query(
      `SELECT batch_id, decision, COUNT(*)::text AS c
         FROM open_review WHERE batch_id = ANY($1::uuid[]) GROUP BY batch_id, decision`,
      [batchIds],
    );
    for (const r of rows) {
      const cur =
        map.get(r.batch_id) ?? { pending: 0, openedEntry: 0, openedFulltext: 0, denied: 0, rereview: 0 };
      const n = Number.parseInt(r.c, 10);
      if (r.decision === 'PENDING') cur.pending = n;
      if (r.decision === 'OPEN_ENTRY') cur.openedEntry = n;
      if (r.decision === 'OPEN_FULLTEXT') cur.openedFulltext = n;
      if (r.decision === 'DENY') cur.denied = n;
      if (r.decision === 'REREVIEW') cur.rereview = n;
      map.set(r.batch_id, cur);
    }
    return map;
  }

  private async decisionStats(batchId: string): Promise<{
    pending: number;
    openedEntry: number;
    openedFulltext: number;
    denied: number;
    rereview: number;
  }> {
    const map = await this.statsMap([batchId]);
    return (
      map.get(batchId) ?? { pending: 0, openedEntry: 0, openedFulltext: 0, denied: 0, rereview: 0 }
    );
  }

  private async workflowStatusMap(
    bizIds: string[],
  ): Promise<Map<string, 'RUNNING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>> {
    const map = new Map<string, 'RUNNING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>();
    if (bizIds.length === 0) return map;
    const rows: Array<{ biz_id: string; status: string; rn: string }> = await this.dataSource.query(
      `SELECT biz_id, status, ROW_NUMBER() OVER (PARTITION BY biz_id ORDER BY created_at DESC)::text AS rn
         FROM workflow_instance WHERE biz_type = $1 AND biz_id = ANY($2::uuid[])`,
      [WorkflowBizType.OPEN_BATCH, bizIds],
    );
    for (const r of rows) {
      if (r.rn === '1') map.set(r.biz_id, r.status as 'RUNNING' | 'APPROVED' | 'REJECTED' | 'CANCELLED');
    }
    return map;
  }

  private toReviewDto(r: OpenReview, names: Map<string, string>): OpenReviewDto {
    return {
      id: r.id,
      batchId: r.batchId,
      itemId: r.itemId,
      danghao: r.danghao,
      title: r.title,
      year: r.year,
      securityLevel: r.securityLevel,
      decision: r.decision as OpenDecision,
      reason: r.reason,
      reviewerId: r.reviewerId,
      reviewerName: r.reviewerId ? (names.get(r.reviewerId) ?? null) : null,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
    };
  }

  private async fondsNameMap(ids: Array<string | null>): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (uniq.length === 0) return new Map();
    const rows = await this.fondsRepo.find({ where: { id: In(uniq) } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async userNameMap(ids: Array<string | null>): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (uniq.length === 0) return new Map();
    const rows = await this.userRepo.find({
      where: { id: In(uniq) },
      select: ['id', 'displayName', 'username'],
    });
    return new Map(rows.map((r) => [r.id, r.displayName || r.username]));
  }
}
