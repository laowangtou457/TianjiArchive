import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  WORKFLOW_BIZ_TYPE_LABELS,
  WORKFLOW_INSTANCE_STATUS_LABELS,
  WORKFLOW_TASK_STATUS_LABELS,
  hasPermission,
  type CreateWorkflowDefDto,
  type PermissionSnapshot,
  type RoleCode,
  type StartWorkflowDto,
  type WorkflowAction,
  type WorkflowActionDto,
  type WorkflowBizType,
  type WorkflowDefDto,
  type WorkflowInstanceDto,
  type WorkflowNodeDto,
  type WorkflowTaskDto,
} from '@tianji/shared';
import { WorkflowDef } from '../../infra/database/entities/workflow-def.entity';
import { WorkflowNodeRow } from '../../infra/database/entities/workflow-node.entity';
import { WorkflowInstance } from '../../infra/database/entities/workflow-instance.entity';
import { WorkflowTask } from '../../infra/database/entities/workflow-task.entity';
import { AppUser } from '../../infra/database/entities/user.entity';

/**
 * 业务回调：审批通过后由引擎调用，实现「审批结果落库」。
 *
 * 契约：回调**必须幂等**（同一实例可能因重试被调用两次），且自行处理事务。
 * 抛错语义：引擎会把实例标记为已通过但记录错误日志 —— 审批结论已成事实，
 * 不能因为业务落库失败就把审批回滚；由运维按日志重放（幂等设计使然）。
 */
export type WorkflowCallbackHandler = (instance: WorkflowInstance) => Promise<void>;

/** 实例列表查询 */
export interface WorkflowInstanceQuery {
  bizType?: WorkflowBizType;
  status?: string;
  bizId?: string;
  /** 只看与我相关（我发起的或待我处理的） */
  mine?: boolean;
  page?: number;
  size?: number;
}

/**
 * 可配置审批流引擎（对齐泰坦「流程类型 / 环节流向 / 环节回调 / 环节权限」）。
 *
 * ## 为什么自己写而不引第三方
 *
 * 档案审批的判定依据是「角色 + 权限域 + 业务单据」，且审批结论要写回业务表
 * （开放标识、销毁执行）。BPMN 引擎（Flowable/Camunda）能表达流程，但：
 *   1) 引入 Java 侧组件，与现有 Node 单栈运维成本不匹配；
 *   2) 档案场景的流程拓扑极浅（1-3 个环节顺序流转），用不上网关/并行/子流程；
 *   3) 关键是「环节回调」，需要强类型访问业务表，跨语言反而更绕。
 *
 * ## 数据模型
 *
 *   def（流程类型）──1:N── node（环节，seq 连续）
 *     └─ 实例 instance（一次业务动作）──1:N── task（每环节一条待办，按角色共享）
 *
 * ## 并发
 *
 * 审批动作在事务内 `SELECT ... FOR UPDATE` 锁实例行，再校验「当前环节待办是否已处理」，
 * 避免两个人同时点「通过」把流程推进两格（双人误触是审批系统最常见的事故）。
 */
@Injectable()
export class WorkflowService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowService.name);

  /** 回调注册表：key = node.onApprove */
  private readonly callbacks = new Map<string, WorkflowCallbackHandler>();

  constructor(
    @InjectRepository(WorkflowDef) private readonly defRepo: Repository<WorkflowDef>,
    @InjectRepository(WorkflowNodeRow) private readonly nodeRepo: Repository<WorkflowNodeRow>,
    @InjectRepository(WorkflowInstance)
    private readonly instanceRepo: Repository<WorkflowInstance>,
    @InjectRepository(WorkflowTask) private readonly taskRepo: Repository<WorkflowTask>,
    @InjectRepository(AppUser) private readonly userRepo: Repository<AppUser>,
    private readonly dataSource: DataSource,
  ) {}

  public onModuleInit(): void {
    this.logger.log(
      `审批流引擎就绪；已注册回调 ${this.callbacks.size} 个${
        this.callbacks.size ? `：${[...this.callbacks.keys()].join(', ')}` : ''
      }`,
    );
  }

  // ==========================================================================
  // 回调注册
  // ==========================================================================

  /** 业务模块在 onModuleInit 中注册（重复注册以最后一次为准） */
  public registerCallback(key: string, handler: WorkflowCallbackHandler): void {
    this.callbacks.set(key, handler);
    this.logger.log(`注册审批回调：${key}`);
  }

  // ==========================================================================
  // 流程定义
  // ==========================================================================

  public async listDefs(): Promise<WorkflowDefDto[]> {
    const defs = await this.defRepo.find({ order: { bizType: 'ASC', version: 'DESC' } });
    const nodes = await this.nodeRepo.find({ order: { seq: 'ASC' } });
    return defs.map((d) => this.toDefDto(d, nodes.filter((n) => n.defId === d.id)));
  }

  /**
   * 新建流程定义。
   *
   * 同一业务类型只允许一条 enabled：新流程启用时自动停用旧的 —— 否则
   * `activeDef` 取哪条就是随机行为，审批会「时好时坏」。
   */
  public async createDef(dto: CreateWorkflowDefDto, userId: string | null): Promise<WorkflowDefDto> {
    const code = dto.code?.trim();
    if (!code) throw new BizException(ErrorCode.BAD_REQUEST, '流程编码不能为空');
    const exists = await this.defRepo.findOne({ where: { code } });
    if (exists) throw new BizException(ErrorCode.CONFLICT, `流程编码「${code}」已存在`);
    this.validateNodes(dto.nodes);

    const def = await this.dataSource.transaction(async (manager) => {
      if (dto.enabled !== false) {
        await manager.update(WorkflowDef, { bizType: dto.bizType, enabled: true }, { enabled: false });
      }
      const row = manager.create(WorkflowDef, {
        code,
        name: dto.name,
        bizType: dto.bizType,
        version: 1,
        enabled: dto.enabled !== false,
        description: dto.description ?? null,
        createdBy: userId,
      });
      const saved = await manager.save(row);
      await this.replaceNodes(manager, saved.id, dto.nodes);
      return saved;
    });
    return (await this.detailDef(def.id)) as WorkflowDefDto;
  }

  /** 修改流程定义（全量替换环节；在途实例按各自 def 快照继续，不受影响） */
  public async updateDef(
    id: string,
    dto: Partial<CreateWorkflowDefDto>,
    _userId: string | null,
  ): Promise<WorkflowDefDto> {
    const def = await this.defRepo.findOne({ where: { id } });
    if (!def) throw new BizException(ErrorCode.NOT_FOUND, '流程定义不存在');
    if (dto.nodes) this.validateNodes(dto.nodes);

    await this.dataSource.transaction(async (manager) => {
      if (dto.enabled === true) {
        await manager.update(
          WorkflowDef,
          { bizType: dto.bizType ?? def.bizType, enabled: true },
          { enabled: false },
        );
      }
      await manager.update(
        WorkflowDef,
        { id },
        {
          name: dto.name ?? def.name,
          description: dto.description ?? def.description,
          enabled: dto.enabled ?? def.enabled,
          version: def.version + 1,
        },
      );
      if (dto.nodes) {
        await manager.delete(WorkflowNodeRow, { defId: id });
        await this.replaceNodes(manager, id, dto.nodes);
      }
    });
    return (await this.detailDef(id)) as WorkflowDefDto;
  }

  public async detailDef(id: string): Promise<WorkflowDefDto | null> {
    const def = await this.defRepo.findOne({ where: { id } });
    if (!def) return null;
    const nodes = await this.nodeRepo.find({ where: { defId: id }, order: { seq: 'ASC' } });
    return this.toDefDto(def, nodes);
  }

  /** 删除流程定义（有在途实例则拒绝，避免审批「断头」） */
  public async deleteDef(id: string): Promise<{ deleted: boolean }> {
    const running = await this.instanceRepo.count({ where: { defId: id, status: 'RUNNING' } });
    if (running > 0) {
      throw new BizException(
        ErrorCode.CONFLICT,
        `该流程还有 ${running} 个流转中的实例，不能删除；请先停用`,
      );
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(WorkflowNodeRow, { defId: id });
      await manager.delete(WorkflowDef, { id });
    });
    return { deleted: true };
  }

  // ==========================================================================
  // 实例
  // ==========================================================================

  /**
   * 发起流程。同一业务对象不允许并存两个流转中实例（否则会出现
   * 「两个审批都通过、谁后落库谁覆盖」的双写）。
   */
  public async start(
    dto: StartWorkflowDto,
    user: PermissionSnapshot,
  ): Promise<WorkflowInstanceDto> {
    const { def, nodes } = await this.activeDef(dto.bizType);
    const dup = await this.instanceRepo.findOne({
      where: { bizType: dto.bizType, bizId: dto.bizId, status: 'RUNNING' },
    });
    if (dup) {
      throw new BizException(
        ErrorCode.CONFLICT,
        `该单据已有流转中的审批（${WORKFLOW_INSTANCE_STATUS_LABELS.RUNNING}），请勿重复提交`,
      );
    }

    const first = nodes[0];
    const instance = await this.dataSource.transaction(async (manager) => {
      const row = manager.create(WorkflowInstance, {
        defId: def.id,
        bizType: dto.bizType,
        bizId: dto.bizId,
        title: dto.title,
        summary: dto.summary ?? null,
        status: 'RUNNING',
        currentSeq: first.seq,
        payload: dto.payload ?? {},
        initiatorId: user.userId,
      });
      const saved = await manager.save(row);
      await manager.save(
        manager.create(WorkflowTask, {
          instanceId: saved.id,
          nodeId: first.id,
          seq: first.seq,
          nodeName: first.name,
          roleCode: first.roleCode,
          status: 'PENDING',
        }),
      );
      return saved;
    });
    this.logger.log(
      `流程发起 ${WORKFLOW_BIZ_TYPE_LABELS[dto.bizType]} bizId=${dto.bizId} 实例=${instance.id}`,
    );
    return (await this.detail(instance.id, user)) as WorkflowInstanceDto;
  }

  /**
   * 处理当前环节（通过 / 驳回）。
   *
   * 校验顺序（任一不过即拒，且都在锁内做）：
   *   1) 实例存在且 RUNNING；
   *   2) 当前环节有 PENDING 待办（防重复处理/并发双开）；
   *   3) 用户角色匹配该环节（roleCode='*' 或角色命中）；
   *   4) 若环节声明了 permDomain，用户须具备该域 APPROVE 或 WRITE 权限。
   */
  public async act(
    instanceId: string,
    dto: WorkflowActionDto,
    user: PermissionSnapshot,
  ): Promise<WorkflowInstanceDto> {
    const action: WorkflowAction = dto.action;
    if (action === 'REJECT' && !(dto.opinion ?? '').trim()) {
      throw new BizException(ErrorCode.BAD_REQUEST, '驳回必须填写意见');
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const instance = await manager
        .getRepository(WorkflowInstance)
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id', { id: instanceId })
        .getOne();
      if (!instance) throw new BizException(ErrorCode.NOT_FOUND, '审批实例不存在');
      if (instance.status !== 'RUNNING') {
        throw new BizException(
          ErrorCode.CONFLICT,
          `该审批已${WORKFLOW_INSTANCE_STATUS_LABELS[instance.status]}，不能再处理`,
        );
      }

      const task = await manager.getRepository(WorkflowTask).findOne({
        where: { instanceId, seq: instance.currentSeq, status: 'PENDING' },
      });
      if (!task) {
        throw new BizException(ErrorCode.CONFLICT, '当前环节没有待办（可能已被他人处理）');
      }

      const node = await manager.getRepository(WorkflowNodeRow).findOne({ where: { id: task.nodeId } });
      if (!node) throw new BizException(ErrorCode.NOT_FOUND, '环节配置缺失，请联系管理员');

      if (!this.canHandle(node, user)) {
        throw new BizException(
          ErrorCode.FORBIDDEN,
          `当前环节「${node.name}」需 ${node.roleCode === '*' ? '指定权限' : node.roleCode} 角色处理`,
        );
      }
      if (action === 'REJECT' && !node.allowReject) {
        throw new BizException(ErrorCode.BAD_REQUEST, `环节「${node.name}」不允许驳回`);
      }

      const now = new Date();
      task.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      task.actedBy = user.userId;
      task.actedByName = user.displayName;
      task.opinion = dto.opinion?.trim() || null;
      task.actedAt = now;
      await manager.save(task);

      if (action === 'REJECT') {
        instance.status = 'REJECTED';
        instance.finishedAt = now;
        await manager.save(instance);
        return { instance, finished: true };
      }

      // 通过：找下一个环节
      const next = await manager.getRepository(WorkflowNodeRow).findOne({
        where: { defId: instance.defId, seq: instance.currentSeq + 1 },
      });
      if (!next) {
        instance.status = 'APPROVED';
        instance.finishedAt = now;
        await manager.save(instance);
        return { instance, finished: true };
      }
      instance.currentSeq = next.seq;
      await manager.save(instance);
      await manager.save(
        manager.create(WorkflowTask, {
          instanceId: instance.id,
          nodeId: next.id,
          seq: next.seq,
          nodeName: next.name,
          roleCode: next.roleCode,
          status: 'PENDING',
        }),
      );
      return { instance, finished: false };
    });

    // 审批结论已落库 → 末环节通过时触发业务回调（事务外，失败不影响审批事实）
    if (result.finished && result.instance.status === 'APPROVED') {
      await this.fireCallback(result.instance);
    }
    return (await this.detail(instanceId, user)) as WorkflowInstanceDto;
  }

  /** 撤回（仅发起人本人或 R0，且仍在流转中） */
  public async cancel(
    instanceId: string,
    user: PermissionSnapshot,
    reason?: string,
  ): Promise<WorkflowInstanceDto> {
    const instance = await this.instanceRepo.findOne({ where: { id: instanceId } });
    if (!instance) throw new BizException(ErrorCode.NOT_FOUND, '审批实例不存在');
    if (instance.status !== 'RUNNING') {
      throw new BizException(ErrorCode.CONFLICT, '仅流转中的审批可撤回');
    }
    if (instance.initiatorId !== user.userId && !user.roles.includes('R0')) {
      throw new BizException(ErrorCode.FORBIDDEN, '只有发起人或系统管理员可以撤回');
    }
    const now = new Date();
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        WorkflowTask,
        { instanceId, status: 'PENDING' },
        {
          status: 'SKIPPED',
          actedBy: user.userId,
          actedByName: user.displayName,
          opinion: reason?.trim() ? `撤回：${reason.trim()}` : '撤回',
          actedAt: now,
        },
      );
      await manager.update(WorkflowInstance, { id: instanceId }, { status: 'CANCELLED', finishedAt: now });
    });
    return (await this.detail(instanceId, user)) as WorkflowInstanceDto;
  }

  /** 业务对象当前（或最近一次）审批实例 */
  public async findForBiz(bizType: WorkflowBizType, bizId: string): Promise<WorkflowInstance | null> {
    const running = await this.instanceRepo.findOne({
      where: { bizType, bizId, status: 'RUNNING' },
    });
    if (running) return running;
    const last = await this.instanceRepo.find({
      where: { bizType, bizId },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    return last[0] ?? null;
  }

  /** 实例详情（含时间线） */
  public async detail(id: string, user: PermissionSnapshot): Promise<WorkflowInstanceDto | null> {
    const instance = await this.instanceRepo.findOne({ where: { id } });
    if (!instance) return null;
    const [def, tasks] = await Promise.all([
      this.defRepo.findOne({ where: { id: instance.defId } }),
      this.taskRepo.find({ where: { instanceId: id }, order: { seq: 'ASC' } }),
    ]);
    const names = await this.resolveNames([
      instance.initiatorId,
      ...tasks.map((t) => t.actedBy),
    ]);
    const defName = def?.name ?? '（流程定义已删除）';
    const currentTask = tasks.find((t) => t.seq === instance.currentSeq);
    return {
      id: instance.id,
      defId: instance.defId,
      defCode: def?.code ?? '-',
      defName,
      bizType: instance.bizType,
      bizId: instance.bizId,
      title: instance.title,
      summary: instance.summary,
      status: instance.status,
      currentSeq: instance.currentSeq,
      currentNodeName: instance.status === 'RUNNING' ? (currentTask?.nodeName ?? null) : null,
      initiatorId: instance.initiatorId,
      initiatorName: instance.initiatorId ? (names.get(instance.initiatorId) ?? null) : null,
      createdAt: instance.createdAt.toISOString(),
      finishedAt: instance.finishedAt ? instance.finishedAt.toISOString() : null,
      canAct: instance.status === 'RUNNING' && this.canHandleTask(currentTask, user),
      tasks: tasks.map((t) => this.toTaskDto(t, names)),
    };
  }

  /** 实例分页列表 */
  public async list(
    query: WorkflowInstanceQuery,
    user: PermissionSnapshot,
  ): Promise<{ items: WorkflowInstanceDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(query.size ?? 20)));
    const qb = this.instanceRepo.createQueryBuilder('i');
    if (query.bizType) qb.andWhere('i.biz_type = :bt', { bt: query.bizType });
    if (query.status) qb.andWhere('i.status = :st', { st: query.status });
    if (query.bizId) qb.andWhere('i.biz_id = :bi', { bi: query.bizId });
    if (query.mine) {
      const roleCodes = user.roles.length ? user.roles : ['__none__'];
      qb.andWhere(
        `(i.initiator_id = :uid OR EXISTS (
            SELECT 1 FROM workflow_task t
            WHERE t.instance_id = i.id AND t.status = 'PENDING'
              AND (t.role_code = '*' OR t.role_code IN (:...roles))
         ))`,
        { uid: user.userId, roles: roleCodes },
      );
    }
    qb.orderBy('i.created_at', 'DESC').skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();

    const defs = await this.defRepo.find({
      where: rows.length ? { id: In([...new Set(rows.map((r) => r.defId))]) } : { id: '__none__' },
    });
    const defMap = new Map(defs.map((d) => [d.id, d]));
    const names = await this.resolveNames(rows.map((r) => r.initiatorId));

    return {
      items: rows.map((r) => {
        const def = defMap.get(r.defId);
        return {
          id: r.id,
          defId: r.defId,
          defCode: def?.code ?? '-',
          defName: def?.name ?? '（流程定义已删除）',
          bizType: r.bizType,
          bizId: r.bizId,
          title: r.title,
          summary: r.summary,
          status: r.status,
          currentSeq: r.currentSeq,
          currentNodeName: null,
          initiatorId: r.initiatorId,
          initiatorName: r.initiatorId ? (names.get(r.initiatorId) ?? null) : null,
          createdAt: r.createdAt.toISOString(),
          finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
          canAct: false,
          tasks: [],
        };
      }),
      total,
      page,
      size,
    };
  }

  /** 我的待办（按角色待办池） */
  public async myTasks(user: PermissionSnapshot): Promise<
    Array<WorkflowTaskDto & { title: string; bizType: WorkflowBizType; bizId: string }>
  > {
    const roleCodes = user.roles.length ? user.roles : ['__none__'];
    const rows = await this.taskRepo
      .createQueryBuilder('t')
      .innerJoin(WorkflowInstance, 'i', 'i.id = t.instance_id')
      .where(`t.status = 'PENDING'`)
      .andWhere(`(t.role_code = '*' OR t.role_code IN (:...roles))`, { roles: roleCodes })
      .andWhere(`i.status = 'RUNNING'`)
      .orderBy('t.created_at', 'ASC')
      .limit(200)
      .getMany();
    if (rows.length === 0) return [];
    const instances = await this.instanceRepo.find({
      where: { id: In([...new Set(rows.map((r) => r.instanceId))]) },
    });
    const map = new Map(instances.map((i) => [i.id, i]));
    return rows
      .filter((r) => map.has(r.instanceId))
      .map((r) => {
        const inst = map.get(r.instanceId) as WorkflowInstance;
        return {
          ...this.toTaskDto(r, new Map<string, string>()),
          title: inst.title,
          bizType: inst.bizType,
          bizId: inst.bizId,
        };
      });
  }

  /** 超时未处理统计（调度器每小时调用，仅告警不自动跳过） */
  public async scanTimeouts(): Promise<number> {
    const rows: Array<{ cnt: string }> = await this.taskRepo.query(`
      SELECT COUNT(*)::text AS cnt
      FROM workflow_task t
      JOIN workflow_node n ON n.id = t.node_id
      JOIN workflow_instance i ON i.id = t.instance_id
      WHERE t.status = 'PENDING'
        AND i.status = 'RUNNING'
        AND COALESCE(n.timeout_hours, 0) > 0
        AND t.created_at < now() - (n.timeout_hours || ' hours')::interval
    `);
    const cnt = Number.parseInt(rows[0]?.cnt ?? '0', 10);
    if (cnt > 0) {
      this.logger.warn(`审批超时待办 ${cnt} 条（未自动流转，需人工催办）`);
    }
    return cnt;
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private async activeDef(
    bizType: WorkflowBizType,
  ): Promise<{ def: WorkflowDef; nodes: WorkflowNodeRow[] }> {
    const def = await this.defRepo.findOne({
      where: { bizType, enabled: true },
      order: { version: 'DESC' },
    });
    if (!def) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `业务「${WORKFLOW_BIZ_TYPE_LABELS[bizType]}」未配置启用中的审批流程，请先在流程配置中启用`,
      );
    }
    const nodes = await this.nodeRepo.find({ where: { defId: def.id }, order: { seq: 'ASC' } });
    if (nodes.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, `流程「${def.name}」未配置环节`);
    }
    return { def, nodes };
  }

  private validateNodes(nodes: WorkflowNodeDto[]): void {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '流程至少需要一个环节');
    }
    const seqs = nodes.map((n) => n.seq).sort((a, b) => a - b);
    seqs.forEach((s, i) => {
      if (s !== i + 1) {
        throw new BizException(ErrorCode.BAD_REQUEST, '环节序号必须从 1 开始且连续');
      }
    });
    for (const n of nodes) {
      if (!n.name?.trim()) throw new BizException(ErrorCode.BAD_REQUEST, '环节名称不能为空');
    }
  }

  private async replaceNodes(
    manager: import('typeorm').EntityManager,
    defId: string,
    nodes: WorkflowNodeDto[],
  ): Promise<void> {
    const rows = nodes
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((n) =>
        manager.create(WorkflowNodeRow, {
          defId,
          seq: n.seq,
          name: n.name,
          roleCode: n.roleCode ?? '*',
          permDomain: n.permDomain ?? null,
          onApprove: n.onApprove ?? null,
          allowReject: n.allowReject !== false,
          timeoutHours: n.timeoutHours ?? null,
        }),
      );
    await manager.save(rows);
  }

  private async fireCallback(instance: WorkflowInstance): Promise<void> {
    const lastNode = await this.nodeRepo.findOne({
      where: { defId: instance.defId, seq: instance.currentSeq },
    });
    const key = lastNode?.onApprove;
    if (!key) return;
    const handler = this.callbacks.get(key);
    if (!handler) {
      this.logger.error(`审批回调未注册：${key}（实例 ${instance.id}），业务落库需人工处理`);
      return;
    }
    try {
      await handler(instance);
      this.logger.log(`审批回调完成：${key} 实例=${instance.id}`);
    } catch (err) {
      this.logger.error(`审批回调失败：${key} 实例=${instance.id} err=${(err as Error).message}`);
    }
  }

  /** 角色 + 权限域双校验（权限域优先于角色，便于「谁的岗谁审」） */
  private canHandle(node: WorkflowNodeRow, user: PermissionSnapshot): boolean {
    if (node.roleCode && node.roleCode !== '*') {
      if (!user.roles.includes(node.roleCode as RoleCode)) return false;
    }
    if (node.permDomain) {
      const domain = node.permDomain as Parameters<typeof hasPermission>[1];
      const ok = hasPermission(user, domain, 'APPROVE') || hasPermission(user, domain, 'WRITE');
      if (!ok) return false;
    }
    return true;
  }

  private canHandleTask(task: WorkflowTask | undefined, user: PermissionSnapshot): boolean {
    if (!task) return false;
    if (task.roleCode === '*' ) return true;
    return user.roles.includes(task.roleCode as RoleCode);
  }

  private async resolveNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (uniq.length === 0) return new Map();
    const users = await this.userRepo.find({
      where: { id: In(uniq) },
      select: ['id', 'displayName', 'username'],
    });
    return new Map(users.map((u) => [u.id, u.displayName || u.username]));
  }

  private toDefDto(def: WorkflowDef, nodes: WorkflowNodeRow[]): WorkflowDefDto {
    return {
      id: def.id,
      code: def.code,
      name: def.name,
      bizType: def.bizType,
      version: def.version,
      enabled: def.enabled,
      description: def.description,
      nodes: nodes
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((n) => ({
          id: n.id,
          seq: n.seq,
          name: n.name,
          roleCode: (n.roleCode as RoleCode | '*') ?? '*',
          permDomain: n.permDomain,
          onApprove: n.onApprove,
          allowReject: n.allowReject,
          timeoutHours: n.timeoutHours,
        })),
      createdAt: def.createdAt.toISOString(),
      updatedAt: def.updatedAt.toISOString(),
    };
  }

  private toTaskDto(t: WorkflowTask, names: Map<string, string>): WorkflowTaskDto {
    return {
      id: t.id,
      instanceId: t.instanceId,
      nodeId: t.nodeId,
      seq: t.seq,
      nodeName: t.nodeName,
      roleCode: (t.roleCode as RoleCode | '*') ?? '*',
      status: t.status,
      actedBy: t.actedBy,
      actedByName:
        t.actedByName ??
        (t.actedBy ? (names.get(t.actedBy) ?? null) : null),
      opinion: t.opinion,
      actedAt: t.actedAt ? t.actedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
    };
  }
}

// 供控制器/测试复用的标签导出（避免各处再 import 一堆枚举）
export const WORKFLOW_TASK_STATUS_TEXT = WORKFLOW_TASK_STATUS_LABELS;
