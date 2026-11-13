import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  APPRAISAL_DECISION_LABELS,
  BizException,
  ErrorCode,
  RETENTION_LABELS,
  RETENTION_YEARS,
  WorkflowBizType,
  WorkflowCallback,
  type AppraisalEntryDto,
  type AppraisalExecuteResult,
  type AppraisalTaskDto,
  type CreateAppraisalTaskDto,
  type DecideAppraisalDto,
  type PermissionSnapshot,
  type Retention,
} from '@tianji/shared';
import { AppraisalTask } from '../../infra/database/entities/appraisal-task.entity';
import { AppraisalEntry } from '../../infra/database/entities/appraisal-entry.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { EsIndexerService } from '../../infra/elasticsearch/es-indexer.service';
import { RecycleService } from '../recycle/recycle.service';
import { WorkflowService } from '../workflow/workflow.service';

/** 单任务明细上限：一次鉴定几万件既不现实也无法人工判断，超出应拆分任务 */
const MAX_ENTRIES_PER_TASK = 20000;
const BATCH_LIMIT = 500;

export interface AppraisalQuery {
  status?: string;
  keyword?: string;
  page?: number;
  size?: number;
}

export interface AppraisalEntryQuery {
  decision?: string;
  keyword?: string;
  page?: number;
  size?: number;
}

/**
 * 档案鉴定（F-19，对齐泰坦「鉴定任务 / 任务处理 / 鉴定处置表」）。
 *
 * ## 到期判定口径（必须与档案业务一致）
 *
 *   PERM（永久）          永不到期
 *   Y30（定期 30 年）     now.year − item.year ≥ 30
 *   Y10（定期 10 年）     now.year − item.year ≥ 10
 *
 * 用「年度差」而不是「docDate + 期限」：档案保管期限自**形成年度**起算，
 * 精确到日反而会因 docDate 缺失把整批件漏掉（导入数据常见）。
 *
 * ## 为什么处置与执行分两步
 *
 * 处置（decide）只是「人在明细上表态」，可反复改；执行（execute）才动业务表。
 * 分开的价值：一次鉴定会开几个小时会，会议中随时改结论，最后统一执行；
 * 若边点边改库，中途改主意就要回滚已改的保管期限，无法留痕。
 *
 * ## 销毁为什么必须过审批
 *
 * 销毁不可逆且涉及合规责任。结论为 DESTROY 的件在 execute 时**只执行非销毁部分**，
 * 销毁行要求存在 `APPRAISAL_DESTROY` 审批实例且状态为 APPROVED；
 * 否则计入 pendingApproval 并原样保留，等审批通过后再执行一次。
 */
@Injectable()
export class AppraisalService implements OnModuleInit {
  private readonly logger = new Logger(AppraisalService.name);

  constructor(
    @InjectRepository(AppraisalTask) private readonly taskRepo: Repository<AppraisalTask>,
    @InjectRepository(AppraisalEntry) private readonly entryRepo: Repository<AppraisalEntry>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Volume) private readonly volumeRepo: Repository<Volume>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(AppUser) private readonly userRepo: Repository<AppUser>,
    private readonly dataSource: DataSource,
    private readonly esIndexer: EsIndexerService,
    private readonly recycleService: RecycleService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * 注册销毁审批回调：审批通过后由引擎调用，执行本任务的销毁处置。
   *
   * 只做「销毁」这一件事（其余结论在 execute 时已落库），
   * 因此回调是幂等的：已执行的明细会被 `executed = false` 条件排除。
   */
  public onModuleInit(): void {
    this.workflow.registerCallback(WorkflowCallback.APPRAISAL_DESTROY_EXEC, async (instance) => {
      await this.executeAfterApproval(instance.bizId, instance.initiatorId);
    });
  }

  // ==========================================================================
  // 任务
  // ==========================================================================

  public async list(
    query: AppraisalQuery,
    user?: PermissionSnapshot,
  ): Promise<{ items: AppraisalTaskDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(query.size ?? 20)));

    const qb = this.taskRepo.createQueryBuilder('t');
    if (query.status) qb.andWhere('t.status = :st', { st: query.status });
    if (query.keyword) {
      qb.andWhere('(t.name ILIKE :kw OR t.task_no ILIKE :kw)', { kw: `%${query.keyword}%` });
    }
    // 数据范围：非全量授权时只返回本人可及全宗的任务（全库范围任务 fonds_id 为空，仅全量授权可见）
    if (user && user.fondsIds !== null) {
      const ids = user.fondsIds.length ? user.fondsIds : ['00000000-0000-0000-0000-000000000000'];
      qb.andWhere('t.fonds_id = ANY(:fondsIds)', { fondsIds: ids });
    }
    qb.orderBy('t.created_at', 'DESC')
      .skip((page - 1) * size)
      .take(size);
    const [rows, total] = await qb.getManyAndCount();

    return {
      items: await this.buildDtos(rows),
      total,
      page,
      size,
    };
  }

  public async detail(id: string): Promise<AppraisalTaskDto> {
    const row = await this.taskRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '鉴定任务不存在');
    const [dto] = await this.buildDtos([row]);
    return dto;
  }

  /** 新建任务并生成明细 */
  public async create(
    dto: CreateAppraisalTaskDto,
    user: PermissionSnapshot,
  ): Promise<AppraisalTaskDto> {
    if (!dto.name?.trim()) throw new BizException(ErrorCode.BAD_REQUEST, '任务名称不能为空');
    if (!Number.isFinite(dto.yearFrom) || !Number.isFinite(dto.yearTo)) {
      throw new BizException(ErrorCode.BAD_REQUEST, '年度区间不合法');
    }
    if (dto.yearFrom > dto.yearTo) {
      throw new BizException(ErrorCode.BAD_REQUEST, '起始年度不能大于结束年度');
    }

    const seqRow: Array<{ v: string }> = await this.dataSource.query(
      `SELECT nextval('seq_appraisal_task_no')::text AS v`,
    );
    const taskNo = `JD${new Date().getFullYear()}-${String(seqRow[0]?.v ?? '1').padStart(3, '0')}`;

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        taskNo,
        name: dto.name.trim(),
        status: 'DRAFT',
        fondsId: dto.fondsId ?? null,
        yearFrom: dto.yearFrom,
        yearTo: dto.yearTo,
        retentions: dto.retentions ?? [],
        categoryCode: dto.categoryCode ?? null,
        dueOnly: dto.dueOnly !== false,
        basis: dto.basis ?? null,
        remark: dto.remark ?? null,
        createdBy: user.userId,
      }),
    );

    const generated = await this.generateEntries(task.id);
    await this.taskRepo.update({ id: task.id }, { total: generated });
    this.logger.log(`鉴定任务 ${taskNo} 生成明细 ${generated} 件`);
    return this.detail(task.id);
  }

  /** 重新生成明细（仅允许在尚无处置结论时；否则会丢掉已表的态） */
  public async regenerate(id: string): Promise<AppraisalTaskDto> {
    const task = await this.taskRepo.findOne({ where: { id } });
    if (!task) throw new BizException(ErrorCode.NOT_FOUND, '鉴定任务不存在');
    if (task.status === 'FINISHED' || task.status === 'CANCELLED') {
      throw new BizException(ErrorCode.CONFLICT, '已完成/已作废的任务不能重新生成明细');
    }
    const decided = await this.entryRepo.count({ where: { taskId: id } });
    if (decided > 0) {
      const touched: Array<{ c: string }> = await this.dataSource.query(
        `SELECT COUNT(*)::text AS c FROM appraisal_entry WHERE task_id = $1 AND decision <> 'PENDING'`,
        [id],
      );
      if (Number.parseInt(touched[0]?.c ?? '0', 10) > 0) {
        throw new BizException(ErrorCode.CONFLICT, '已有处置结论，不能重新生成；请新建任务');
      }
    }
    await this.entryRepo.delete({ taskId: id });
    const generated = await this.generateEntries(id);
    await this.taskRepo.update({ id }, { total: generated, status: 'DRAFT' });
    return this.detail(id);
  }

  public async cancel(id: string, user: PermissionSnapshot): Promise<AppraisalTaskDto> {
    const task = await this.taskRepo.findOne({ where: { id } });
    if (!task) throw new BizException(ErrorCode.NOT_FOUND, '鉴定任务不存在');
    if (task.status === 'FINISHED') {
      throw new BizException(ErrorCode.CONFLICT, '已完成的任务不能作废');
    }
    if (task.status === 'CANCELLED') return this.detail(id);
    await this.taskRepo.update(
      { id },
      { status: 'CANCELLED', updatedAt: new Date() },
    );
    this.logger.log(`鉴定任务 ${task.taskNo} 由 ${user.username} 作废`);
    return this.detail(id);
  }

  // ==========================================================================
  // 明细与处置
  // ==========================================================================

  public async listEntries(
    taskId: string,
    query: AppraisalEntryQuery,
  ): Promise<{ items: AppraisalEntryDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(200, Math.max(1, Number(query.size ?? 20)));

    const qb = this.entryRepo.createQueryBuilder('e').where('e.task_id = :taskId', { taskId });
    if (query.decision) {
      qb.andWhere('e.decision = :d', { d: query.decision });
    }
    if (query.keyword) {
      qb.andWhere('(e.danghao ILIKE :kw OR e.title ILIKE :kw)', { kw: `%${query.keyword}%` });
    }
    qb.orderBy('e.danghao', 'ASC')
      .skip((page - 1) * size)
      .take(size);
    const [rows, total] = await qb.getManyAndCount();
    const names = await this.userNameMap(rows.map((r) => r.decidedBy));

    return {
      items: rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        itemId: r.itemId,
        danghao: r.danghao,
        title: r.title,
        year: r.year,
        retentionBefore: r.retentionBefore,
        retentionAfter: r.retentionAfter,
        decision: r.decision,
        reason: r.reason,
        decidedBy: r.decidedBy,
        decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        executed: r.executed,
        executedAt: r.executedAt ? r.executedAt.toISOString() : null,
      })),
      total,
      page,
      size,
    };
  }

  /** 逐件/批量处置（可反复修改，未执行前都能改） */
  public async decide(
    taskId: string,
    dto: DecideAppraisalDto,
    user: PermissionSnapshot,
  ): Promise<{ updated: number }> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new BizException(ErrorCode.NOT_FOUND, '鉴定任务不存在');
    if (task.status === 'FINISHED' || task.status === 'CANCELLED') {
      throw new BizException(ErrorCode.CONFLICT, '已完成/已作废的任务不能修改处置结论');
    }
    const ids = Array.isArray(dto.ids) ? dto.ids : [];
    if (ids.length === 0) throw new BizException(ErrorCode.BAD_REQUEST, '请选择要处置的条目');
    if (ids.length > BATCH_LIMIT) {
      throw new BizException(ErrorCode.BAD_REQUEST, `单次处置不得超过 ${BATCH_LIMIT} 条`);
    }
    if (!APPRAISAL_DECISION_LABELS[dto.decision]) {
      throw new BizException(ErrorCode.BAD_REQUEST, '处置结论不合法');
    }
    if (dto.decision === 'EXTEND' && !dto.retentionAfter) {
      throw new BizException(ErrorCode.BAD_REQUEST, '延期保管必须指定新的保管期限');
    }
    const reason = dto.reason?.trim() || null;
    if (dto.decision === 'DESTROY' && !reason) {
      throw new BizException(ErrorCode.BAD_REQUEST, '销毁必须填写鉴定意见/理由');
    }

    const res = await this.entryRepo
      .createQueryBuilder()
      .update(AppraisalEntry)
      .set({
        decision: dto.decision,
        retentionAfter: dto.decision === 'EXTEND' ? (dto.retentionAfter as Retention) : null,
        reason,
        decidedBy: user.userId,
        decidedAt: new Date(),
      })
      .where('task_id = :taskId AND id IN (:...ids) AND executed = FALSE', { taskId, ids })
      .execute();

    await this.taskRepo.update({ id: taskId }, { status: 'IN_PROGRESS', updatedAt: new Date() });
    await this.refreshCounters(taskId);
    return { updated: res.affected ?? 0 };
  }

  // ==========================================================================
  // 执行
  // ==========================================================================

  /**
   * 执行处置（把结论落到档案表）。
   *
   * 销毁件需已获审批；未获审批时其余结论照常执行，销毁行保持未执行，
   * 返回 pendingApproval 提示前端去提审。
   */
  public async execute(taskId: string, user: PermissionSnapshot): Promise<AppraisalExecuteResult> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new BizException(ErrorCode.NOT_FOUND, '鉴定任务不存在');
    if (task.status === 'FINISHED') {
      throw new BizException(ErrorCode.CONFLICT, '该任务已执行完毕');
    }
    if (task.status === 'CANCELLED') {
      throw new BizException(ErrorCode.CONFLICT, '已作废的任务不能执行');
    }

    const approved = await this.isDestroyApproved(taskId);

    const entries = await this.entryRepo.find({
      where: { taskId, executed: false, decision: In(['KEEP', 'EXTEND', 'TRANSFER', 'DESTROY']) },
      order: { danghao: 'ASC' },
    });
    if (entries.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '没有可执行的处置结论（请先逐件鉴定）');
    }

    const result: AppraisalExecuteResult = {
      requested: entries.length,
      kept: 0,
      extended: 0,
      transferred: 0,
      destroyed: 0,
      pendingApproval: 0,
      failed: [],
    };
    const now = new Date();
    const touchedItemIds: string[] = [];

    for (const entry of entries) {
      try {
        if (entry.decision === 'DESTROY') {
          if (!approved) {
            result.pendingApproval += 1;
            continue;
          }
          await this.destroyItem(entry, task, user, now);
          result.destroyed += 1;
        } else {
          await this.applyNonDestroy(entry, task, now);
          if (entry.decision === 'KEEP') result.kept += 1;
          if (entry.decision === 'EXTEND') result.extended += 1;
          if (entry.decision === 'TRANSFER') result.transferred += 1;
        }
        await this.entryRepo.update(
          { id: entry.id },
          { executed: true, executedAt: now },
        );
        touchedItemIds.push(entry.itemId);
      } catch (err) {
        result.failed.push({ id: entry.itemId, reason: (err as Error).message });
      }
    }

    // 封存条件：处置全部执行完 **且** 没有「未鉴定」的明细。
    // 只判前者会出现「3465 件还没看，任务已显示完成」的假完成。
    const [remaining, untouched] = await Promise.all([
      this.entryRepo.count({
        where: { taskId, executed: false, decision: In(['KEEP', 'EXTEND', 'TRANSFER', 'DESTROY']) },
      }),
      this.entryRepo.count({ where: { taskId, decision: 'PENDING' } }),
    ]);
    if (remaining === 0 && untouched === 0) {
      await this.taskRepo.update(
        { id: taskId },
        {
          status: 'FINISHED',
          finishedAt: now,
          updatedAt: now,
          destroyCount: result.destroyed,
        },
      );
    } else {
      await this.refreshCounters(taskId);
    }

    if (touchedItemIds.length > 0) this.esIndexer.enqueueMany(touchedItemIds);
    this.logger.log(
      `鉴定任务 ${task.taskNo} 执行：保管${result.kept}/延期${result.extended}/移交${result.transferred}/销毁${result.destroyed}/待审批${result.pendingApproval}`,
    );
    return result;
  }

  /** 提交销毁审批（仅当存在 DESTROY 结论且尚未审批） */
  public async submitDestroy(taskId: string, user: PermissionSnapshot): Promise<AppraisalTaskDto> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new BizException(ErrorCode.NOT_FOUND, '鉴定任务不存在');
    const destroyRows = await this.entryRepo.find({
      where: { taskId, decision: 'DESTROY', executed: false },
    });
    if (destroyRows.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '该任务没有待执行的销毁结论');
    }
    const existing = await this.workflow.findForBiz(WorkflowBizType.APPRAISAL_DESTROY, taskId);
    if (existing && existing.status === 'RUNNING') {
      throw new BizException(ErrorCode.CONFLICT, '销毁审批已在流转中，请勿重复提交');
    }

    const inst = await this.workflow.start(
      {
        bizType: WorkflowBizType.APPRAISAL_DESTROY,
        bizId: taskId,
        title: `鉴定销毁审批：${task.name}`,
        summary: `共 ${destroyRows.length} 件待销毁，任务号 ${task.taskNo}`,
        payload: {
          taskNo: task.taskNo,
          destroyCount: destroyRows.length,
          samples: destroyRows.slice(0, 10).map((r) => `${r.danghao} ${r.title}`),
        },
      },
      user,
    );
    await this.taskRepo.update({ id: taskId }, { workflowInstanceId: inst.id, updatedAt: new Date() });
    return this.detail(taskId);
  }

  /**
   * 审批通过后的销毁执行（回调入口）。
   * 不校验操作人权限——授权来自审批结论本身，user 仅用于回收站留痕。
   */
  public async executeAfterApproval(taskId: string, operatorId: string | null): Promise<number> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) {
      this.logger.error(`销毁回调：鉴定任务 ${taskId} 不存在`);
      return 0;
    }
    const entries = await this.entryRepo.find({
      where: { taskId, decision: 'DESTROY', executed: false },
    });
    if (entries.length === 0) return 0;

    const now = new Date();
    const actor: PermissionSnapshot = {
      userId: operatorId ?? '00000000-0000-0000-0000-000000000000',
      username: 'workflow',
      displayName: '销毁审批',
      roles: [],
      grants: {},
      maxSecurityLevel: 'SECRET',
      scopes: [],
      fondsIds: null,
      orgIds: null,
      selfOnly: false,
    };
    let done = 0;
    const touched: string[] = [];
    for (const entry of entries) {
      try {
        await this.destroyItem(entry, task, actor, now);
        await this.entryRepo.update({ id: entry.id }, { executed: true, executedAt: now });
        touched.push(entry.itemId);
        done += 1;
      } catch (err) {
        this.logger.error(`销毁失败 ${entry.danghao}: ${(err as Error).message}`);
      }
    }
    if (touched.length > 0) this.esIndexer.enqueueMany(touched);

    const [remaining, untouched] = await Promise.all([
      this.entryRepo.count({
        where: { taskId, executed: false, decision: In(['KEEP', 'EXTEND', 'TRANSFER', 'DESTROY']) },
      }),
      this.entryRepo.count({ where: { taskId, decision: 'PENDING' } }),
    ]);
    if (remaining === 0 && untouched === 0) {
      await this.taskRepo.update(
        { id: taskId },
        { status: 'FINISHED', finishedAt: now, updatedAt: now, destroyCount: done },
      );
    }
    this.logger.log(`销毁审批通过，任务 ${task.taskNo} 执行销毁 ${done} 件`);
    return done;
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 任务行 → DTO（批量补统计/名称/审批状态，避免 N+1） */
  private async buildDtos(rows: AppraisalTask[]): Promise<AppraisalTaskDto[]> {
    if (rows.length === 0) return [];
    const [counts, fondsMap, userMap, wfMap] = await Promise.all([
      this.countByDecision(rows.map((r) => r.id)),
      this.fondsNameMap(rows.map((r) => r.fondsId)),
      this.userNameMap(rows.map((r) => r.createdBy)),
      this.workflowStatusMap(WorkflowBizType.APPRAISAL_DESTROY, rows.map((r) => r.id)),
    ]);
    return rows.map((r) => {
      const c = counts.get(r.id);
      return {
        id: r.id,
        taskNo: r.taskNo,
        name: r.name,
        status: r.status,
        fondsId: r.fondsId,
        fondsName: r.fondsId ? (fondsMap.get(r.fondsId) ?? null) : null,
        yearFrom: r.yearFrom,
        yearTo: r.yearTo,
        retentions: r.retentions ?? [],
        categoryCode: r.categoryCode,
        dueOnly: r.dueOnly,
        basis: r.basis,
        remark: r.remark,
        total: r.total,
        pending: c?.pending ?? 0,
        keep: c?.keep ?? 0,
        extend: c?.extend ?? 0,
        transfer: c?.transfer ?? 0,
        destroy: c?.destroy ?? 0,
        workflowInstanceId: r.workflowInstanceId,
        workflowStatus: wfMap.get(r.id) ?? null,
        createdBy: r.createdBy,
        createdByName: r.createdBy ? (userMap.get(r.createdBy) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      };
    });
  }

  /** 按任务筛选条件生成明细（INSERT ... SELECT 一次完成，避免逐件往返） */
  private async generateEntries(taskId: string): Promise<number> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new BizException(ErrorCode.NOT_FOUND, '鉴定任务不存在');

    const params: unknown[] = [taskId, task.yearFrom, task.yearTo];
    let idx = 4;
    const clauses: string[] = [
      `i.deleted = FALSE`,
      `i.status = 'ARCHIVED'`,
      `i.year BETWEEN $2 AND $3`,
    ];
    if (task.fondsId) {
      clauses.push(`i.fonds_id = $${idx}`);
      params.push(task.fondsId);
      idx += 1;
    }
    if (task.categoryCode) {
      clauses.push(`i.category_code = $${idx}`);
      params.push(task.categoryCode);
      idx += 1;
    }
    if (Array.isArray(task.retentions) && task.retentions.length > 0) {
      clauses.push(`i.retention = ANY($${idx}::varchar[])`);
      params.push(task.retentions);
      idx += 1;
    }
    if (task.dueOnly) {
      // 到期判定：永久不参评；10 年/30 年按年度差
      clauses.push(`(
        (i.retention = 'Y10' AND (EXTRACT(YEAR FROM now())::int - i.year) >= 10)
        OR (i.retention = 'Y30' AND (EXTRACT(YEAR FROM now())::int - i.year) >= 30)
      )`);
    }

    const inserted: Array<{ c: string }> = await this.dataSource.query(
      `WITH picked AS (
         SELECT i.id, i.danghao, i.title, i.year, i.retention
         FROM archive_item i
         WHERE ${clauses.join(' AND ')}
         ORDER BY i.danghao
         LIMIT ${MAX_ENTRIES_PER_TASK}
       ), ins AS (
         INSERT INTO appraisal_entry (task_id, item_id, danghao, title, year, retention_before, decision)
         SELECT $1::uuid, p.id, p.danghao, p.title, p.year, p.retention, 'PENDING'
         FROM picked p
         ON CONFLICT (task_id, item_id) DO NOTHING
         RETURNING 1
       )
       SELECT COUNT(*)::text AS c FROM ins`,
      params,
    );
    return Number.parseInt(inserted[0]?.c ?? '0', 10);
  }

  /** 非销毁类处置落库 */
  private async applyNonDestroy(
    entry: AppraisalEntry,
    task: AppraisalTask,
    now: Date,
  ): Promise<void> {
    const item = await this.itemRepo.findOne({ where: { id: entry.itemId } });
    if (!item) throw new Error('档案条目不存在或已删除');
    const appraisal = {
      taskId: task.id,
      taskNo: task.taskNo,
      decision: entry.decision,
      reason: entry.reason,
      at: now.toISOString(),
    };

    if (entry.decision === 'EXTEND') {
      if (!entry.retentionAfter) throw new Error('延期处置缺少新保管期限');
      await this.itemRepo.update(
        { id: item.id },
        {
          retention: entry.retentionAfter,
          extra: { ...(item.extra ?? {}), appraisal },
          updatedAt: now,
        } as never,
      );
      return;
    }

    if (entry.decision === 'TRANSFER') {
      await this.itemRepo.update(
        { id: item.id },
        {
          extra: {
            ...(item.extra ?? {}),
            appraisal,
            transfer: { status: 'PENDING', taskId: task.id, at: now.toISOString() },
          },
          updatedAt: now,
        } as never,
      );
      return;
    }

    // KEEP：只留痕，不改业务字段
    await this.itemRepo.update(
      { id: item.id },
      { extra: { ...(item.extra ?? {}), appraisal }, updatedAt: now } as never,
    );
  }

  /** 销毁（软删除 + 入回收站，可还原 —— 真删由回收站清空动作负责） */
  private async destroyItem(
    entry: AppraisalEntry,
    task: AppraisalTask,
    user: PermissionSnapshot,
    now: Date,
  ): Promise<void> {
    const item = await this.itemRepo.findOne({ where: { id: entry.itemId } });
    if (!item) throw new Error('档案条目不存在或已删除');
    if (item.deleted) throw new Error('该件已被删除');

    await this.itemRepo.update({ id: item.id }, { deleted: true, updatedAt: now });
    if (item.volumeId) {
      await this.volumeRepo.decrement({ id: item.volumeId }, 'itemCount', 1);
    }
    await this.recycleService.record({
      objectType: 'ITEM',
      objectId: item.id,
      objectLabel: `${item.danghao} ${item.title}`,
      snapshot: {
        danghao: item.danghao,
        title: item.title,
        volumeId: item.volumeId,
        status: item.status,
        securityLevel: item.securityLevel,
        destroyReason: entry.reason,
        appraisalTaskId: task.id,
        appraisalTaskNo: task.taskNo,
      },
      deletedBy: user.userId,
    });
  }

  /**
   * 刷新明细统计。destroy 计数只统计「未执行的销毁结论」，
   * 用于任务列表上的「待审批销毁 N 件」。
   */
  private async refreshCounters(taskId: string): Promise<void> {
    const rows: Array<{ decision: string; c: string }> = await this.dataSource.query(
      `SELECT decision, COUNT(*)::text AS c FROM appraisal_entry WHERE task_id = $1 GROUP BY decision`,
      [taskId],
    );
    const total = rows.reduce((s, r) => s + Number.parseInt(r.c, 10), 0);
    const destroy = Number.parseInt(rows.find((r) => r.decision === 'DESTROY')?.c ?? '0', 10);
    await this.taskRepo.update({ id: taskId }, { total, destroyCount: destroy });
  }

  private async countByDecision(
    taskIds: string[],
  ): Promise<Map<string, { pending: number; keep: number; extend: number; transfer: number; destroy: number }>> {
    const map = new Map<
      string,
      { pending: number; keep: number; extend: number; transfer: number; destroy: number }
    >();
    if (taskIds.length === 0) return map;
    const rows: Array<{ task_id: string; decision: string; c: string }> = await this.dataSource.query(
      `SELECT task_id, decision, COUNT(*)::text AS c
         FROM appraisal_entry WHERE task_id = ANY($1::uuid[]) GROUP BY task_id, decision`,
      [taskIds],
    );
    for (const r of rows) {
      const cur =
        map.get(r.task_id) ?? { pending: 0, keep: 0, extend: 0, transfer: 0, destroy: 0 };
      const n = Number.parseInt(r.c, 10);
      if (r.decision === 'PENDING') cur.pending = n;
      if (r.decision === 'KEEP') cur.keep = n;
      if (r.decision === 'EXTEND') cur.extend = n;
      if (r.decision === 'TRANSFER') cur.transfer = n;
      if (r.decision === 'DESTROY') cur.destroy = n;
      map.set(r.task_id, cur);
    }
    return map;
  }

  private async isDestroyApproved(taskId: string): Promise<boolean> {
    const inst = await this.workflow.findForBiz(WorkflowBizType.APPRAISAL_DESTROY, taskId);
    return inst?.status === 'APPROVED';
  }

  private async workflowStatusMap(
    bizType: WorkflowBizType,
    bizIds: string[],
  ): Promise<Map<string, 'RUNNING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>> {
    const map = new Map<string, 'RUNNING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>();
    if (bizIds.length === 0) return map;
    const rows: Array<{ biz_id: string; status: string; rn: string }> = await this.dataSource.query(
      `SELECT biz_id, status, ROW_NUMBER() OVER (PARTITION BY biz_id ORDER BY created_at DESC)::text AS rn
         FROM workflow_instance WHERE biz_type = $1 AND biz_id = ANY($2::uuid[])`,
      [bizType, bizIds],
    );
    for (const r of rows) {
      if (r.rn === '1') map.set(r.biz_id, r.status as 'RUNNING' | 'APPROVED' | 'REJECTED' | 'CANCELLED');
    }
    return map;
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

/** 供前端/文档展示的期限口径说明（与 generateEntries 的 SQL 保持一致） */
export function appraisalDueHint(): string {
  return `到期判定：永久不参评；${RETENTION_LABELS.Y10} 自形成年度起满 ${RETENTION_YEARS.Y10} 年；${RETENTION_LABELS.Y30} 满 ${RETENTION_YEARS.Y30} 年`;
}
