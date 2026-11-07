import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, Not, Repository } from 'typeorm';
import {
  ApprovalAction,
  BorrowStatus,
  BORROW_MIN_DAYS,
  BORROW_RULES_FALLBACK,
  BORROW_TRANSITIONS,
  SECURITY_LEVEL_LABELS,
  SecurityLevel,
  checkPermission,
  borrowRulesHint,
  isBorrowTerminal,
  type BorrowApprovalDto,
  type BorrowMode,
  type BorrowOrderDto,
  type BorrowRules,
  type BorrowStatsReport,
  type OperationType,
  type PermissionDomain,
  type PermissionSnapshot,
  BizException,
  ErrorCode,
} from '@tianji/shared';
import { BorrowOrder } from '../../infra/database/entities/borrow-order.entity';
import { BorrowApproval } from '../../infra/database/entities/borrow-approval.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { AppUser } from '../../infra/database/entities/user.entity';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { AuditLogService } from '../audit/audit-log.service';
import { ParamService } from '../param/param.service';

/** 借阅申请入参 */
export interface CreateBorrowInput {
  itemId: string;
  purpose: string;
  mode: BorrowMode;
  expectReturn: string;
}

/** 审批入参 */
export interface ApproveBorrowInput {
  action: ApprovalAction;
  opinion: string;
  level?: number;
}

/** 列表查询入参 */
export interface BorrowQuery {
  page?: number;
  size?: number;
  status?: BorrowStatus[];
  applicantId?: string;
  itemId?: string;
  /** true 时仅返回本人申请 */
  mine?: boolean;
  keyword?: string;
  overdueOnly?: boolean;
}

/** 分页结果 */
export interface BorrowPage {
  items: BorrowOrderDto[];
  total: number;
  page: number;
  size: number;
}

/** 借阅业务参数（前端下发用，与后端校验同源） */
export type BorrowRulesDto = BorrowRules & { hint: string };

/**
 * 借阅服务（F-06）。
 *
 * 状态机（packages/shared `BORROW_TRANSITIONS` 为唯一权威）：
 *   PENDING → APPROVED → LENT → RETURNED
 *   PENDING → REJECTED / CANCELLED
 *   LENT → OVERDUE → RETURNED
 *
 * 审批路由（按密级）：
 *   PUBLIC / INTERNAL → 1 级审批（R1 档案管理员或 R4 领导）
 *   SECRET           → 2 级审批（1 级 R1 → 2 级 R4）
 *
 * 合规（PRD §6）：审批意见必填、全程留痕（borrow_approval + audit_log）、
 * 档号/题名随单快照，避免档案变更导致历史失真。
 */
@Injectable()
export class BorrowService {
  private readonly logger = new Logger(BorrowService.name);

  public constructor(
    @InjectRepository(BorrowOrder) private readonly orderRepo: Repository<BorrowOrder>,
    @InjectRepository(BorrowApproval) private readonly approvalRepo: Repository<BorrowApproval>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(AppUser) private readonly userRepo: Repository<AppUser>,
    private readonly dataSource: DataSource,
    private readonly accessBuilder: AccessFilterBuilder,
    private readonly auditLog: AuditLogService,
    private readonly paramService: ParamService,
  ) {}

  // ==========================================================================
  // 业务规则（参数化，PR-P1：业务代码禁止策略字面量）
  // ==========================================================================

  /**
   * 读取当前生效的借阅规则。
   *
   * 所有阈值（总借期 / 续借次数 / 单次续借天数 / 默认借期）都来自 sys_param，
   * 读不到时 `ParamService` 内部回落 PARAM_DEFS 默认值并告警，
   * **不会**出现 undefined 流入日期运算变成 NaN。
   */
  public async loadRules(): Promise<BorrowRules> {
    try {
      return await this.paramService.getBorrowRules();
    } catch (err) {
      // 参数服务异常不能让借阅业务整体 500（借阅是高频入口），
      // 回落 PRD 封版默认值并告警，等价于「出故障时按制度默认值执行」。
      this.logger.error(
        `读取借阅参数失败，本次回落默认规则: ${(err as Error).message}`,
      );
      return BORROW_RULES_FALLBACK;
    }
  }

  /** 借阅规则（含用户可见文案），供 `GET /borrow/config` 下发给前端 */
  public async config(): Promise<BorrowRulesDto> {
    const rules = await this.loadRules();
    return { ...rules, hint: borrowRulesHint(rules) };
  }

  // ==========================================================================
  // 申请
  // ==========================================================================

  /** 创建借阅申请（含重复申请校验与逾期限制） */
  public async create(input: CreateBorrowInput, user: PermissionSnapshot): Promise<BorrowOrderDto> {
    const item = await this.requireAccessibleItem(input.itemId, user);
    const rules = await this.loadRules();

    // 1) 参数校验
    const purpose = (input.purpose ?? '').trim();
    if (purpose.length < 5) {
      throw BizException.badRequest('借阅目的至少 5 个字');
    }
    const expectReturn = this.normalizeDate(input.expectReturn);
    this.assertApplyExpectReturn(expectReturn, rules);

    // 2) 逾期限制：存在逾期未还则不可再借
    const overdueCount = await this.orderRepo.count({
      where: { applicantId: user.userId, status: BorrowStatus.OVERDUE },
    });
    if (overdueCount > 0) {
      throw new BizException(
        ErrorCode.BORROW_OVERDUE_LIMIT,
        `您有 ${overdueCount} 笔逾期未还记录，请先归还后再申请`,
      );
    }

    // 3) 重复申请：同一档案存在进行中单据
    const dup = await this.orderRepo.count({
      where: {
        applicantId: user.userId,
        itemId: item.id,
        status: In([BorrowStatus.PENDING, BorrowStatus.APPROVED, BorrowStatus.LENT, BorrowStatus.OVERDUE]),
      },
    });
    if (dup > 0) {
      throw new BizException(ErrorCode.BORROW_DUPLICATE, '该档案已有进行中的借阅申请，请勿重复提交');
    }

    // 4) 按密级路由审批级数
    const requiredLevel = this.requiredLevelOf(item.securityLevel as SecurityLevel);

    // 5) 单号生成（目录序号 + 计数，事务内生成避免并发重复）
    const orderNo = await this.nextOrderNo();

    const entity = this.orderRepo.create({
      orderNo,
      applicantId: user.userId,
      itemId: item.id,
      purpose,
      mode: input.mode,
      expectReturn,
      status: BorrowStatus.PENDING,
      renewCount: 0,
      currentLevel: 1,
      requiredLevel,
    });
    const saved = await this.orderRepo.save(entity);

    this.logger.log(
      `借阅申请 ${saved.orderNo} 已提交（密级 ${item.securityLevel}，需 ${requiredLevel} 级审批）`,
    );
    return this.toDto(await this.loadOrder(saved.id), []);
  }

  // ==========================================================================
  // 审批
  // ==========================================================================

  /**
   * 审批：APPROVE 推进到下一级或 APPROVED；REJECT 直接 REJECTED。
   * 秘密级需两级：第 1 级通过后仍为 PENDING（currentLevel=2），第 2 级通过才 APPROVED。
   *
   * 并发防护（QA 缺陷 #4 同类）：整个「读取 → 校验 → 写入」在单据互斥锁内完成。
   *
   * 原实现是「锁外 loadOrder，锁内 update」，两个审批人同时点「通过」时：
   *  - 都读到 currentLevel=1、status=PENDING；
   *  - 都通过 `actingLevel === order.currentLevel` 检查；
   *  - 各自写一条 approval + update，秘密级单据会跳级（1 级直通 APPROVED）
   *    或产生两条同级审批记录。
   * 现在把读取挪进锁内，后到者必然读到「已推进到第 2 级」的状态而被拦下；
   * 写入再带 CAS（WHERE status + currentLevel 为读取值）兜住多实例场景。
   */
  public async approve(
    orderId: string,
    input: ApproveBorrowInput,
    user: PermissionSnapshot,
  ): Promise<BorrowOrderDto> {
    return this.withOrderLock(orderId, async () => {
      // 锁内重读：拿到的是「上一个持锁者提交后」的最新状态
      const order = await this.loadOrder(orderId);

      if (order.status !== BorrowStatus.PENDING) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          `当前状态（${order.status}）不允许审批，仅「待审批」可审批`,
        );
      }
      // 不允许自审（PRD §5.4 合规底线）。
      //
      // 【故意不调用 invalidateSnapshot】注意：这里是**防自审的字段比对**，
      // 不是权限变更场景，全程不读权限快照。给它补 invalidate 是无效代码，
      // 更糟的是会让后来人误以为审批链路依赖快照 —— 实际依据就是这一行比对。
      // 已在 `PERMISSION_MUTATION_EXCLUSIONS`（@tianji/shared）显式排除，
      // CI 静态自检不会把它扫成「疑似遗漏」。
      if (order.applicantId === user.userId) {
        throw BizException.forbidden('不可审批本人提交的借阅申请');
      }

      const opinion = (input.opinion ?? '').trim();
      if (opinion.length < 2) {
        throw BizException.badRequest('审批意见必填（至少 2 个字）');
      }

      // 审批级别校验：必须按序（第 1 级 → 第 2 级）。
      //
      // `level` 语义（与前端契约一致）：
      //  - 显式传 level：以传入值为准。这是**真实攻击面** —— 前端缓存了 level=1
      //    的审批页，两人同时点击时都声明要办第 1 级，后到者必须被拒；
      //  - 不传 level：按「当前应审级别」办理（正常单据流，供脚本/命令行使用）。
      //
      // 级别本身不足以约束「一人办两级」的场景（不传 level 时会自动跟随），
      // 因此额外加一道「同一审批人不得重复签署」，这是合规底线。
      const actingLevel = input.level ?? order.currentLevel;
      if (actingLevel !== order.currentLevel) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          `审批次序错误：当前应审批第 ${order.currentLevel} 级（本次提交为第 ${actingLevel} 级）`,
        );
      }
      // 审批人级别能力：第 2 级（终审）仅 R4 领导可签。
      // 这不是「按角色硬绑级别」的替代品，而是与上面「次序校验」正交的能力约束：
      // 次序校验保证「该审第几级」，能力校验保证「此人是否有资格办这一级」。
      // 例：R1 档案管理员即便把 level 传成 2 且单据当前正好在 2 级，也不得越权终审。
      if (actingLevel > this.resolveApproverLevel(user)) {
        throw BizException.forbidden(
          `您的审批级别为第 ${this.resolveApproverLevel(user)} 级，无权办理第 ${actingLevel} 级审批`,
        );
      }
      // 同一审批人不得在同一单据上重复签署：一人不能独立完成两级审批（合规底线）
      const signed = await this.approvalRepo.find({ where: { orderId: order.id } });
      if (signed.some((a) => a.approverId === user.userId)) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          '您已审批过该借阅单，不可重复签署（双级审批须由不同审批人完成）',
        );
      }

      let nextStatus: BorrowStatus;
      let nextLevel = order.currentLevel;

      if (input.action === ApprovalAction.REJECT) {
        nextStatus = BorrowStatus.REJECTED;
      } else if (actingLevel < order.requiredLevel) {
        // 还需更高一级审批，保持 PENDING 但推进级别
        nextStatus = BorrowStatus.PENDING;
        nextLevel = actingLevel + 1;
      } else {
        nextStatus = BorrowStatus.APPROVED;
      }

      // 仅在状态真正发生变化时校验流转。
      // 双级审批的第 1 级通过后仍为 PENDING（只推进 currentLevel），不属于状态流转，
      // 因此不能拿 PENDING → PENDING 去套 BORROW_TRANSITIONS（该表是唯一权威，不放宽）。
      if (nextStatus !== order.status) {
        this.assertTransition(order.status, nextStatus);
      }

      // CAS：WHERE 带上读取时的 status/currentLevel，多实例下后到者不命中即失败
      const cas = await this.orderRepo.update(
        { id: order.id, status: order.status, currentLevel: order.currentLevel },
        { status: nextStatus, currentLevel: nextLevel },
      );
      if (!cas.affected) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          '该借阅单已被他人处理，请刷新后重试',
        );
      }

      // 审批留痕（必填意见）——放在状态推进成功之后写，
      // 避免并发失败方留下一条「没生效的审批记录」污染审批链。
      await this.approvalRepo.save(
        this.approvalRepo.create({
          orderId: order.id,
          approverId: user.userId,
          level: actingLevel,
          action: input.action,
          opinion,
        }),
      );

      this.logger.log(
        `借阅单 ${order.orderNo} 第 ${actingLevel} 级审批：${input.action}（经办 ${user.username}）`,
      );
      return this.toDto(await this.loadOrder(orderId));
    });
  }

  /**
   * 借出登记（档案管理员办理，APPROVED → LENT），同时记录借出日作为借期起算基准。
   *
   * 并发防护：锁内重读 + CAS。原实现「锁外读、锁外写」下，两人同时点「借出」
   * 会各自写一次 borrowDate，后写者把借出日改晚，直接放大了总借期余量（BR-06-3 口径被绕过）。
   */
  public async lend(orderId: string, user: PermissionSnapshot): Promise<BorrowOrderDto> {
    return this.withOrderLock(orderId, async () => {
      const order = await this.loadOrder(orderId);
      this.assertTransition(order.status, BorrowStatus.LENT);

      // BR-06-3：借出日 = 实际办理借出当日，是后续续借计算总借期的基准。
      // 用服务器**本地时区**自然日（不是 UTC）：晚间办理借出若按 UTC 会记成次日，
      // 跨年时更明显。toLocalDateOnly 与此口径一致。
      const borrowDate = this.toLocalDateOnly(new Date());

      const cas = await this.orderRepo.update(
        { id: order.id, status: order.status },
        { status: BorrowStatus.LENT, borrowDate },
      );
      if (!cas.affected) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          '该借阅单已被他人处理，请刷新后重试',
        );
      }
      this.logger.log(
        `借阅单 ${order.orderNo} 已借出（借出日 ${borrowDate}，经办 ${user.username}）`,
      );
      return this.toDto(await this.loadOrder(orderId));
    });
  }

  /**
   * 归还登记（LENT/OVERDUE → RETURNED）。
   *
   * 并发防护：锁内重读 + CAS。重复提交归还会让 actualReturn 被覆盖、
   * 逾期数据被「洗白」为按期归还，影响统计口径与逾期追溯。
   */
  public async giveBack(
    orderId: string,
    remark: string | undefined,
    user: PermissionSnapshot,
  ): Promise<BorrowOrderDto> {
    return this.withOrderLock(orderId, async () => {
      const order = await this.loadOrder(orderId);
      if (order.status !== BorrowStatus.LENT && order.status !== BorrowStatus.OVERDUE) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          `当前状态（${order.status}）不允许归还`,
        );
      }
      const cas = await this.orderRepo.update(
        { id: order.id, status: order.status },
        {
          status: BorrowStatus.RETURNED,
          actualReturn: new Date(),
          returnRemark: remark?.trim() || null,
        },
      );
      if (!cas.affected) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          '该借阅单已被他人处理，请刷新后重试',
        );
      }
      this.logger.log(`借阅单 ${order.orderNo} 已归还（经办 ${user.username}）`);
      return this.toDto(await this.loadOrder(orderId));
    });
  }

  /**
   * 撤销申请（仅申请人本人，PENDING/APPROVED → CANCELLED）。
   *
   * 并发防护：锁内重读 + CAS。原实现「锁外读状态、锁外写」，与审批并发时
   * 可能出现「审批刚通过、撤销同时生效」，最终状态取决于写入顺序，
   * 出现「已批准又被撤销」的脏数据。
   */
  public async cancel(orderId: string, user: PermissionSnapshot): Promise<BorrowOrderDto> {
    return this.withOrderLock(orderId, async () => {
      const order = await this.loadOrder(orderId);
      if (order.applicantId !== user.userId) {
        throw new BizException(ErrorCode.BORROW_NOT_OWNER, '只能撤销本人提交的借阅申请');
      }
      this.assertTransition(order.status, BorrowStatus.CANCELLED);
      const cas = await this.orderRepo.update(
        { id: order.id, status: order.status },
        { status: BorrowStatus.CANCELLED },
      );
      if (!cas.affected) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          '该借阅单已被他人处理，请刷新后重试',
        );
      }
      return this.toDto(await this.loadOrder(orderId));
    });
  }

  /**
   * 续借（PRD 5.4 BR-06-1 ~ BR-06-7）。
   *
   * 前置条件：本人申请 + 已借出 + 未逾期 + 未超续借次数 + 单次天数不超限。
   * 借期口径：**总借期**——自借出日起算，含续借累计，上限来自
   * `borrow.max_total_days`；单次续借天数上限来自 `borrow.max_renewal_days`
   * （两个独立维度，都要满足）。
   *
   * 并发防护：单据互斥锁内「读取 → 校验 → 写入」，写入带 CAS 兜底多实例。
   *
   * @param extendDays 续借天数；缺省取 `borrow.max_renewal_days`（单次上限）
   */
  public async renew(
    orderId: string,
    user: PermissionSnapshot,
    extendDays?: number,
  ): Promise<BorrowOrderDto> {
    const rules = await this.loadRules();
    const days = extendDays ?? rules.maxRenewalDays;

    // BR-06-7：续借天数必须为整数且 ≥ 下限（最廉价的入参校验放最前面）
    if (!Number.isInteger(days) || days < BORROW_MIN_DAYS) {
      throw BizException.badRequest(`续借天数必须为不小于 ${BORROW_MIN_DAYS} 的整数`);
    }

    return this.withOrderLock(orderId, async () => {
      // 读取放在锁内，保证读到的是「上一个持锁者提交后」的最新状态
      const order = await this.loadOrder(orderId);

      // BR-06-5：仅本人可续借
      if (order.applicantId !== user.userId) {
        throw new BizException(ErrorCode.BORROW_NOT_OWNER, '只能续借本人借阅的档案');
      }
      // BR-06-5：仅「已借出」可续借（待审批不允许）
      if (order.status !== BorrowStatus.LENT) {
        throw new BizException(ErrorCode.BORROW_INVALID_STATE, '仅「已借出」状态可续借');
      }
      // BR-06-4：逾期单不允许续借，须先归还再重新申请。
      // 不能只看 status（逾期状态由定时扫描刷新，存在窗口期），必须按应还日实时判定。
      if (this.isOverdueOrder(order)) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          '借阅单已逾期，不允许续借，请先归还后重新申请',
        );
      }
      // BR-06-2：续借次数上限（0 = 禁止续借）
      if (order.renewCount >= rules.maxRenewalCount) {
        throw new BizException(
          ErrorCode.BORROW_RENEW_LIMIT,
          rules.maxRenewalCount > 0
            ? `续借次数已达上限（${rules.maxRenewalCount} 次）`
            : '当前制度不允许续借，请按期归还',
        );
      }
      // 单次续借天数上限（borrow.max_renewal_days）：
      // 与「总借期」是两个独立维度 —— 总借期还有余量不代表单次可以无限延长。
      if (days > rules.maxRenewalDays) {
        throw BizException.badRequest(
          `单次续借不得超过 ${rules.maxRenewalDays} 天（本次申请 ${days} 天）`,
        );
      }

      const next = this.addDays(order.expectReturn, days);

      // BR-06-1 / BR-06-3：总借期（借出日 → 新应还日）≤ max_total_days。
      //
      // 借出日缺失只会出现在迁移前的历史单据（迁移已按申请日回填）或异常数据。
      // 此时若强行用 createdAt 推算，跨年历史单会被无谓拒绝；
      // 故退化为「不得缩短应还日」的弱校验并告警 —— 新数据必有 borrowDate，不受影响。
      if (order.borrowDate) {
        this.assertTotalBorrowDays(next, order.borrowDate, rules);
      } else {
        this.logger.warn(
          `借阅单 ${order.orderNo} 缺少借出日，跳过总借期上限校验（历史数据），请核对数据完整性`,
        );
        if (next <= order.expectReturn) {
          throw BizException.badRequest('续借后的应还日期必须晚于当前应还日期');
        }
      }

      // CAS 兜底：WHERE 带上读取时的 renewCount + status，
      // 多实例下由数据库行锁串行化，后到者不命中 → affected=0 → 判定并发冲突。
      const result = await this.orderRepo.update(
        { id: order.id, renewCount: order.renewCount, status: order.status },
        { expectReturn: next, renewCount: order.renewCount + 1 },
      );
      if (!result.affected) {
        throw new BizException(
          ErrorCode.BORROW_INVALID_STATE,
          '续借申请处理中或该借阅单状态已变更，请刷新后重试',
        );
      }

      // BR-06-6（PM 裁定为「直接生效 + 必须留痕」）：
      // 续借不产生审批单，但日志须完整覆盖审计所需字段 ——
      // 操作人 / 时间 / 原应还日 / 新应还日 / 续借天数 / 借出日 / 续借次数。
      // 将来若单位要求「续借需审批」，扩展点在这里：把 validate 与 apply 之间
      // 插一段状态迁移即可（validateRenew 与 applyRenew 已拆开，见下方私有方法）。
      this.logger.log(
        `[BORROW_RENEW] orderNo=${order.orderNo} operator=${user.username}(${user.userId}) ` +
          `at=${new Date().toISOString()} oldDue=${order.expectReturn} newDue=${next} ` +
          `days=${days} borrowDate=${order.borrowDate ?? 'UNKNOWN'} ` +
          `renewCount=${order.renewCount + 1}/${rules.maxRenewalCount}`,
      );
      return this.toDto(await this.loadOrder(orderId));
    });
  }

  // ==========================================================================
  // 并发控制
  // ==========================================================================

  /** 按单据粒度的进程内互斥锁表（单实例部署下消除同单据并发） */
  private readonly orderLocks = new Map<string, Promise<void>>();

  /**
   * 以单据 ID 为粒度串行执行任务。
   *
   * 实现：为每个 orderId 维护一条 Promise 链，后续任务 await 前一个任务结束后再执行。
   * 任务结束（成功或失败）后清理链尾，避免 Map 无限增长。
   *
   * 说明：这是单实例内的并发控制；多实例部署时仍需依赖数据库行锁 / CAS 兜底。
   */
  private async withOrderLock<T>(orderId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.orderLocks.get(orderId) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 链尾指向「前序完成 + 本任务占位」，使后续任务排队等待本任务结束
    const tail = prev.then(() => gate);
    this.orderLocks.set(orderId, tail);

    await prev;
    try {
      return await task();
    } finally {
      release();
      // 若本任务已是链尾，清理 Map 项，防止内存泄漏
      if (this.orderLocks.get(orderId) === tail) {
        this.orderLocks.delete(orderId);
      }
    }
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  /** 借阅单列表（按权限范围 + 可选本人过滤） */
  public async list(query: BorrowQuery, user: PermissionSnapshot): Promise<BorrowPage> {
    const page = Math.max(1, Number(query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(query.size ?? 20)));

    const qb = this.orderRepo.createQueryBuilder('o');
    // 数据范围：非管理者默认仅本人单据；具备审批权者可看全部授权范围内单据
    const canSeeAll = this.canDo(user, 'BORROW_APPROVE', 'APPROVE');
    if (query.mine !== false && !canSeeAll) {
      qb.andWhere('o.applicant_id = :accSelf', { accSelf: user.userId });
    }
    if (query.status && query.status.length > 0) {
      qb.andWhere('o.status IN (:...st)', { st: query.status });
    }
    if (query.applicantId) {
      qb.andWhere('o.applicant_id = :app', { app: query.applicantId });
    }
    if (query.itemId) {
      qb.andWhere('o.item_id = :itemId', { itemId: query.itemId });
    }
    if (query.overdueOnly) {
      qb.andWhere('o.status = :ov', { ov: BorrowStatus.OVERDUE });
    }
    if (query.keyword) {
      qb.andWhere('(o.order_no ILIKE :kw OR o.purpose ILIKE :kw)', { kw: `%${query.keyword}%` });
    }

    qb.orderBy('o.created_at', 'DESC').skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();

    const items = await this.toDtoList(rows);
    return { items, total, page, size };
  }

  /** 借阅单详情 */
  public async detail(orderId: string, user: PermissionSnapshot): Promise<BorrowOrderDto> {
    const order = await this.loadOrder(orderId);
    // 非管理员且非本人：需 BORROW_APPROVE 权限（由 Guard 保证），此处仅做数据兜底
    if (
      order.applicantId !== user.userId &&
      !this.canDo(user, 'BORROW_APPROVE', 'APPROVE') &&
      !this.canDo(user, 'BORROW_RETURN', 'WRITE')
    ) {
      throw new BizException(ErrorCode.BORROW_NOT_OWNER, '无权查看该借阅单');
    }
    return this.toDto(order);
  }

  /** 待办统计（工作台用） */
  public async myPendingCount(user: PermissionSnapshot): Promise<number> {
    return this.orderRepo.count({
      where: {
        applicantId: user.userId,
        status: In([BorrowStatus.LENT, BorrowStatus.OVERDUE]),
      },
    });
  }

  /** 待审批数量（审批人工作台用） */
  public async pendingApprovalCount(user: PermissionSnapshot): Promise<number> {
    if (!this.canDo(user, 'BORROW_APPROVE', 'APPROVE')) return 0;
    return this.orderRepo.count({ where: { status: BorrowStatus.PENDING } });
  }

  /** 借阅统计报表（F-07） */
  public async stats(fromIso?: string, toIso?: string): Promise<BorrowStatsReport> {
    const from = fromIso ? new Date(fromIso) : this.monthsAgo(12);
    const to = toIso ? new Date(toIso) : new Date();

    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select("to_char(o.created_at, 'YYYY-MM')", 'month')
      .addSelect('COUNT(*)::int', 'orders')
      .addSelect('COUNT(*) FILTER (WHERE o.status = :ret)::int', 'returned')
      .addSelect('COUNT(*) FILTER (WHERE o.status = :ov)::int', 'overdue')
      .setParameters({ ret: BorrowStatus.RETURNED, ov: BorrowStatus.OVERDUE })
      .where('o.created_at BETWEEN :from AND :to', { from, to })
      .groupBy('month')
      .orderBy('month', 'ASC')
      .getRawMany<{ month: string; orders: string; returned: string; overdue: string }>();

    const byMonth = rows.map((r) => ({
      key: r.month,
      label: r.month,
      orderCount: Number(r.orders),
      itemCount: Number(r.orders),
      returnedCount: Number(r.returned),
      overdueCount: Number(r.overdue),
    }));

    const statusRows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(*)::int', 'cnt')
      .where('o.created_at BETWEEN :from AND :to', { from, to })
      .groupBy('o.status')
      .getRawMany<{ status: BorrowStatus; cnt: string }>();

    const byStatus = statusRows.map((r) => ({
      key: r.status,
      label: r.status,
      orderCount: Number(r.cnt),
      itemCount: Number(r.cnt),
      returnedCount: r.status === BorrowStatus.RETURNED ? Number(r.cnt) : 0,
      overdueCount: r.status === BorrowStatus.OVERDUE ? Number(r.cnt) : 0,
    }));

    const topRaw = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.item_id', 'itemId')
      .addSelect('COUNT(*)::int', 'cnt')
      .where('o.created_at BETWEEN :from AND :to', { from, to })
      .groupBy('o.item_id')
      .orderBy('cnt', 'DESC')
      .limit(10)
      .getRawMany<{ itemId: string; cnt: string }>();

    const itemIds = topRaw.map((r) => r.itemId);
    const itemRows = itemIds.length
      ? await this.itemRepo.find({ where: { id: In(itemIds) }, select: ['id', 'danghao', 'title'] })
      : [];
    const itemMap = new Map(itemRows.map((i) => [i.id, i]));
    const topItems = topRaw.map((r) => {
      const it = itemMap.get(r.itemId);
      return {
        itemId: r.itemId,
        danghao: it?.danghao ?? '',
        title: it?.title ?? '',
        count: Number(r.cnt),
      };
    });

    const totalOrders = byMonth.reduce((s, r) => s + r.orderCount, 0);
    const totalReturned = byMonth.reduce((s, r) => s + r.returnedCount, 0);
    const totalOverdue = byMonth.reduce((s, r) => s + r.overdueCount, 0);

    return {
      generatedAt: new Date().toISOString(),
      totalOrders,
      totalReturned,
      totalOverdue,
      byMonth,
      byStatus,
      topItems,
    };
  }

  // ==========================================================================
  // 定时任务：逾期扫描
  // ==========================================================================

  /**
   * 逾期扫描：LENT 且 expect_return < 今天 → OVERDUE。
   * 由 BorrowScheduler 按 `borrow.overdue_scan_cron` 周期调用。
   *
   * 并发安全：带 CAS（WHERE status = LENT），多实例同时扫描同一单据时
   * 只有第一个更新生效，其余 affected=0 直接跳过，不会重复写审计。
   */
  public async scanOverdue(): Promise<number> {
    const today = this.toDateOnly(new Date());
    const candidates = await this.orderRepo.find({
      where: { status: BorrowStatus.LENT, expectReturn: LessThan(today) },
    });
    if (candidates.length === 0) return 0;

    let flipped = 0;
    for (const order of candidates) {
      const cas = await this.orderRepo.update(
        { id: order.id, status: BorrowStatus.LENT },
        { status: BorrowStatus.OVERDUE },
      );
      if (!cas.affected) continue; // 已被其他实例/操作处理，跳过重复审计
      flipped += 1;
      this.logger.warn(`借阅单 ${order.orderNo} 已逾期（应还 ${order.expectReturn}）`);
      // 逾期为系统行为，仍写入审计（可追溯）
      await this.auditLog.append({
        userId: null,
        username: 'system',
        action: 'UPDATE',
        objectType: 'BORROW_ORDER',
        objectId: order.id,
        result: 'SUCCESS',
        ip: null,
        durationMs: null,
        detail: { reason: 'OVERDUE_SCAN', expectReturn: order.expectReturn },
      });
    }
    return flipped;
  }

  /**
   * 到期提醒名单（`borrow.overdue_remind_days` 天内应还）。
   *
   * @param days 提前天数；缺省读参数。**0 是合法值**（表示关闭提醒），
   *             因此必须显式判 `undefined`，禁止用 `days || 3` 这类短路写法
   *             （0 会被短路成 3，违背管理员「关闭提醒」的意图）。
   */
  public async dueSoon(days?: number): Promise<BorrowOrderDto[]> {
    const remindDays = days ?? (await this.readRemindDays());
    if (remindDays <= 0) {
      // 0/负数 = 不提醒：直接返回空列表，不查库
      this.logger.log('到期提醒已关闭（borrow.overdue_remind_days=0）');
      return [];
    }
    const from = this.toDateOnly(new Date());
    const to = this.addDays(from, remindDays);
    const rows = await this.orderRepo.find({
      where: {
        status: In([BorrowStatus.LENT]),
        expectReturn: Not(IsNull()),
      },
      order: { expectReturn: 'ASC' },
    });
    const filtered = rows.filter((r) => r.expectReturn >= from && r.expectReturn <= to);
    return this.toDtoList(filtered);
  }

  /**
   * 读取到期提醒提前天数。
   *
   * `0` 合法（= 关闭提醒），所以这里不能用 `n || 3`：
   * 参数服务已保证返回有限整数，此处只做防御性兜底。
   */
  private async readRemindDays(): Promise<number> {
    try {
      const n = await this.paramService.getInt('borrow.overdue_remind_days');
      if (!Number.isFinite(n) || Number.isNaN(n)) return 3;
      return n;
    } catch (err) {
      this.logger.error(`读取到期提醒天数失败，回落 3 天: ${(err as Error).message}`);
      return 3;
    }
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  /** 判断当前用户是否具备某功能域的某操作（与 Guard 同一判定函数） */
  private canDo(user: PermissionSnapshot, domain: PermissionDomain, op: OperationType): boolean {
    return checkPermission(user, domain, op).allowed;
  }

  /** 密级 → 审批级数 */
  private requiredLevelOf(level: SecurityLevel): number {
    return level === SecurityLevel.SECRET ? 2 : 1;
  }

  /**
   * 审批人可办理的最高审批级别（能力判定，与「当前应审级别」正交）。
   *
   * 规则（PRD v1.3 §5.4）：
   *  - R4（领导/查档审批人）可办第 2 级（终审）；
   *  - 其余具 BORROW_APPROVE 权限者（如 R1 档案管理员）只能办第 1 级（初审）。
   *
   * 之所以不能只靠角色推导级别，是因为「一人办完两级」必须由
   * 「同一审批人不得重复签署」兜住 —— 两者是不同维度的约束，缺一不可：
   *  - 本方法：这人**够不够格**办这一级；
   *  - 重复签署校验：这张单上这人**有没有**已经签过。
   */
  private resolveApproverLevel(user: PermissionSnapshot): number {
    // 注意：这里刻意**不比对 RoleCode 对象引用**，而是与字面量 `'R4'` 比较。
    //
    // 原因：`RoleCode` 是 `as const` 对象，正常情况下面向同一模块实例没问题；
    // 但在 `vitest` 的 threads 池里，`@tianji/shared` 可能被解析成两份实例
    // （src 源码 + dist 产物），此时 `roles.includes(RoleCode.R4)` 会因引用不等而恒为 false，
    // 表现为「偶发的级别判定失效」——排查成本极高且只在全量跑时复现。
    // 角色码是外部契约（字符串枚举），与字面量比较既等价又免疫实例差异。
    const roles: readonly string[] = user.roles ?? [];
    return roles.includes('R4') ? 2 : 1;
  }

  /** 状态流转合法性校验（唯一权威：BORROW_TRANSITIONS） */
  private assertTransition(from: BorrowStatus, to: BorrowStatus): void {
    const allowed = BORROW_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BizException(
        ErrorCode.BORROW_INVALID_STATE,
        `状态非法：不允许 ${from} → ${to}`,
      );
    }
  }

  /**
   * 申请环节的借期校验：预计归还日距今天数须落在 `[minDays, maxTotalDays]`。
   *
   * 注意：这是「申请时」的一次性校验，基准日是**今天**（此刻申请、自今天起算）。
   * 续借请用 {@link assertTotalBorrowDays}，两者基准日不同，不可混用。
   */
  private assertApplyExpectReturn(dateStr: string, rules: BorrowRules): void {
    const target = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(target.getTime())) {
      throw BizException.badRequest('预计归还日期格式非法（YYYY-MM-DD）');
    }
    const today = new Date(`${this.toDateOnly(new Date())}T00:00:00Z`);
    const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (diffDays < rules.minDays) {
      throw BizException.badRequest('预计归还日期不得早于明天');
    }
    if (diffDays > rules.maxTotalDays) {
      throw BizException.badRequest(`借期不得超过 ${rules.maxTotalDays} 天`);
    }
  }

  /**
   * 续借环节的总借期校验（PRD 5.4 BR-06-1 / BR-06-3）。
   *
   * 校验借阅**总借期**上限（含续借累计），非单次借期。
   * 基准日为**借出日**（`borrowDate`），而非今天：
   *   - 若用「距今天数」，逾期单据的天数为负，会被误判为「远未超限」而放行（反向漏判）；
   *   - 用「新应还日 − 借出日」可准确反映总占用时长。
   *
   * @param nextExpectReturn 续借后的新应还日（YYYY-MM-DD）
   * @param borrowDate       借出日（YYYY-MM-DD）
   * @param rules            当前生效的借阅规则（上限来自参数，不硬编码）
   */
  private assertTotalBorrowDays(
    nextExpectReturn: string,
    borrowDate: string,
    rules: BorrowRules,
  ): void {
    const target = new Date(`${nextExpectReturn}T00:00:00Z`);
    if (Number.isNaN(target.getTime())) {
      throw BizException.badRequest('预计归还日期格式非法（YYYY-MM-DD）');
    }
    const start = new Date(`${borrowDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) {
      throw BizException.badRequest('借出日期数据异常，请联系管理员核对借阅单');
    }
    const totalDays = Math.round((target.getTime() - start.getTime()) / 86400000);
    if (totalDays < rules.minDays) {
      throw BizException.badRequest('续借后的应还日期必须晚于借出日');
    }
    // 边界为闭区间：totalDays === maxTotalDays 本身合法
    if (totalDays > rules.maxTotalDays) {
      throw BizException.badRequest(
        `续借后总借期将超过 ${rules.maxTotalDays} 天上限，请缩短续借天数`,
      );
    }
  }

  /**
   * 判断借阅单是否已逾期（BR-06-4）。
   *
   * 不依赖 `status === OVERDUE`：逾期状态由定时扫描任务刷新，扫描间隔内单据实际已过期
   * 但状态仍是 LENT，仅看状态会漏判。
   */
  private isOverdueOrder(order: BorrowOrder): boolean {
    if (order.status === BorrowStatus.OVERDUE) return true;
    const today = this.toDateOnly(new Date());
    return order.expectReturn < today;
  }

  /** 生成借阅单号：L + yyyyMMdd + 3 位当日序号 */
  private async nextOrderNo(): Promise<string> {
    const today = this.toDateOnly(new Date()).replace(/-/g, '');
    const prefix = `L${today}`;
    const count = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.order_no LIKE :p', { p: `${prefix}%` })
      .getCount();
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** 加载单据（不存在则 404） */
  private async loadOrder(orderId: string): Promise<BorrowOrder> {
    const order = await this.orderRepo.findOne({ where: { id: orderId } });
    if (!order) throw new BizException(ErrorCode.NOT_FOUND, '借阅单不存在');
    return order;
  }

  /** 校验条目可访问（复用统一权限过滤器） */
  private async requireAccessibleItem(itemId: string, user: PermissionSnapshot): Promise<ArchiveItem> {
    const item = await this.itemRepo.findOne({ where: { id: itemId, deleted: false } });
    if (!item) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');
    if (!this.accessBuilder.canAccessRecord(user, item as unknown as Record<string, unknown>)) {
      throw BizException.forbidden('无权访问该档案（密级或数据范围受限）');
    }
    return item;
  }

  /** 批量转 DTO（集中查审批记录与条目/用户信息，避免 N+1） */
  private async toDtoList(rows: BorrowOrder[]): Promise<BorrowOrderDto[]> {
    if (rows.length === 0) return [];
    const orderIds = rows.map((r) => r.id);
    const itemIds = [...new Set(rows.map((r) => r.itemId))];
    const applicantIds = [...new Set(rows.map((r) => r.applicantId))];

    const [approvals, items, users] = await Promise.all([
      this.approvalRepo.find({ where: { orderId: In(orderIds) }, order: { actedAt: 'ASC' } }),
      this.itemRepo.find({ where: { id: In(itemIds) }, select: ['id', 'danghao', 'title', 'securityLevel'] }),
      this.userRepo.find({ where: { id: In(applicantIds) }, select: ['id', 'displayName', 'username'] }),
    ]);

    const itemMap = new Map(items.map((i) => [i.id, i]));
    const userMap = new Map(users.map((u) => [u.id, u]));
    const approvalMap = new Map<string, BorrowApproval[]>();
    for (const a of approvals) {
      const list = approvalMap.get(a.orderId) ?? [];
      list.push(a);
      approvalMap.set(a.orderId, list);
    }

    const approverIds = [...new Set(approvals.map((a) => a.approverId))];
    const approvers = approverIds.length
      ? await this.userRepo.find({ where: { id: In(approverIds) }, select: ['id', 'displayName', 'username'] })
      : [];
    const approverMap = new Map(approvers.map((u) => [u.id, u]));

    return rows.map((r) => this.buildDto(r, itemMap, userMap, approvalMap, approverMap));
  }

  /** 单条转 DTO */
  private async toDto(order: BorrowOrder, _extra?: unknown): Promise<BorrowOrderDto> {
    const approvals: BorrowApproval[] = await this.approvalRepo.find({
      where: { orderId: order.id },
      order: { actedAt: 'ASC' },
    });
    const item = await this.itemRepo.findOne({
      where: { id: order.itemId },
      select: ['id', 'danghao', 'title', 'securityLevel'],
    });
    const applicant = await this.userRepo.findOne({
      where: { id: order.applicantId },
      select: ['id', 'displayName', 'username'],
    });
    const approverIds = [...new Set(approvals.map((a: BorrowApproval) => a.approverId))];
    const approvers = approverIds.length
      ? await this.userRepo.find({ where: { id: In(approverIds) }, select: ['id', 'displayName', 'username'] })
      : [];
    const approverMap = new Map(approvers.map((u) => [u.id, u]));
    return this.buildDto(
      order,
      new Map(item ? [[item.id, item]] : []),
      new Map(applicant ? [[applicant.id, applicant]] : []),
      new Map([[order.id, approvals]]),
      approverMap,
    );
  }

  /** DTO 拼装 */
  private buildDto(
    order: BorrowOrder,
    itemMap: Map<string, ArchiveItem>,
    userMap: Map<string, AppUser>,
    approvalMap: Map<string, BorrowApproval[]>,
    approverMap: Map<string, AppUser>,
  ): BorrowOrderDto {
    const item = itemMap.get(order.itemId);
    const applicant = userMap.get(order.applicantId);
    const approvals = approvalMap.get(order.id) ?? [];
    const today = this.toDateOnly(new Date());
    const overdue =
      order.status === BorrowStatus.OVERDUE ||
      (order.status === BorrowStatus.LENT && order.expectReturn < today);

    return {
      id: order.id,
      orderNo: order.orderNo,
      applicantId: order.applicantId,
      applicantName: applicant?.displayName ?? applicant?.username ?? '',
      itemId: order.itemId,
      itemDanghao: item?.danghao ?? '',
      itemTitle: item?.title ?? '',
      itemSecurityLevel: (item?.securityLevel as SecurityLevel) ?? SecurityLevel.PUBLIC,
      purpose: order.purpose,
      mode: order.mode,
      expectReturn: order.expectReturn,
      borrowDate: order.borrowDate,
      actualReturn: order.actualReturn ? new Date(order.actualReturn).toISOString() : null,
      status: order.status,
      renewCount: order.renewCount,
      overdue,
      approvals: approvals.map<BorrowApprovalDto>((a) => ({
        id: a.id,
        orderId: a.orderId,
        approverId: a.approverId,
        approverName: approverMap.get(a.approverId)?.displayName ?? '',
        level: a.level,
        action: a.action,
        opinion: a.opinion,
        actedAt: new Date(a.actedAt).toISOString(),
      })),
      createdAt: new Date(order.createdAt).toISOString(),
    };
  }

  /** 是否终态（供外部判定） */
  public static isTerminal(status: BorrowStatus): boolean {
    return isBorrowTerminal(status);
  }

  /** 密级中文名（供前端提示） */
  public static levelLabel(level: SecurityLevel): string {
    return SECURITY_LEVEL_LABELS[level] ?? level;
  }

  /** Date → YYYY-MM-DD（UTC 自然日；用于纯日期比较，避免时区偏移影响天数差） */
  private toDateOnly(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Date → YYYY-MM-DD（**服务器本地时区**自然日）。
   *
   * 专用于「借出日」这类**业务当日**语义：档案员晚上 8 点办理借出，
   * 按 UTC 会被记成次日（东八区 UTC+8），跨年时更明显（12/31 → 01/01 记错年度）。
   * 与 {@link toDateOnly}（用于纯日期比较）职责不同，勿混用。
   */
  private toLocalDateOnly(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** YYYY-MM-DD + N 天 */
  private addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return this.toDateOnly(d);
  }

  /** 规范化日期入参（支持 ISO 或 YYYY-MM-DD） */
  private normalizeDate(input: string): string {
    if (!input) throw BizException.badRequest('预计归还日期必填');
    const trimmed = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw BizException.badRequest('预计归还日期格式非法（YYYY-MM-DD）');
    }
    return this.toDateOnly(d);
  }

  /** 近 N 个月前 */
  private monthsAgo(n: number): Date {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - n);
    return d;
  }
}
