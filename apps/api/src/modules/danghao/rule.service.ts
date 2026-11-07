import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import {
  assertValidTemplate,
  buildScopeKey,
  DEFAULT_DANGHAO_TEMPLATE,
  DEFAULT_VOLUME_TEMPLATE,
  describeTemplate,
  DanghaoSegmentType,
  ErrorCode,
  BizException,
  renderDanghao,
  RETENTION_YEARS,
  Retention,
  validateTemplate,
  type CreateDanghaoRuleDto,
  type DanghaoContext,
  type DanghaoSegment,
  type DanghaoRuleDto,
  type DanghaoTemplate,
  type PreviewDanghaoRequest,
  type PreviewDanghaoResponse,
  type ResetCycle,
  type UpdateDanghaoRuleDto,
} from '@tianji/shared';
import { DanghaoRule } from '../../infra/database/entities/danghao-rule.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { OrgNode } from '../../infra/database/entities/org-node.entity';
import { Category } from '../../infra/database/entities/category.entity';
import { DanghaoSequenceService } from './sequence.service';

/**
 * 档号规则引擎（F-02，DA/T 22-2015 §5.3）。
 *
 * 职责：
 *  1) 规则 CRUD（模板合法性校验）；
 *  2) 规则匹配（门类专属规则 > 全宗默认规则 > 内置默认模板）；
 *  3) 试算（与真实生成同源，保证「试算 = 生成」）；
 *  4) 生成档号（调用序列服务取号，模板渲染复用 packages/shared/danghao）。
 *
 * 规则变更策略：仅影响新著录（"新号新规则"），不回溯已有档号。
 */
@Injectable()
export class DanghaoRuleService {
  private readonly logger = new Logger(DanghaoRuleService.name);

  constructor(
    @InjectRepository(DanghaoRule) private readonly ruleRepo: Repository<DanghaoRule>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(OrgNode) private readonly orgRepo: Repository<OrgNode>,
    @InjectRepository(Category) private readonly categoryRepo: Repository<Category>,
    private readonly sequenceService: DanghaoSequenceService,
  ) {}

  // ==========================================================================
  // 规则 CRUD
  // ==========================================================================

  /** 规则列表（可按全宗过滤） */
  public async list(fondsId?: string): Promise<DanghaoRuleDto[]> {
    const qb = this.ruleRepo.createQueryBuilder('r').orderBy('r.createdAt', 'DESC');
    if (fondsId) qb.where('r.fondsId = :fondsId', { fondsId });
    const rows = await qb.getMany();
    return rows.map((r) => this.toDto(r));
  }

  /** 规则详情 */
  public async detail(id: string): Promise<DanghaoRuleDto> {
    const row = await this.ruleRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.RULE_NOT_FOUND, '档号规则不存在');
    return this.toDto(row);
  }

  /** 新建规则 */
  public async create(dto: CreateDanghaoRuleDto): Promise<DanghaoRuleDto> {
    const template: DanghaoTemplate = {
      segments: this.normalizeSegments(dto.segments ?? DEFAULT_DANGHAO_TEMPLATE.segments, dto.zeroPad),
      separator: dto.separator ?? '-',
      };
    const errors = validateTemplate(template);
    if (errors.length > 0) {
      throw new BizException(ErrorCode.RULE_TEMPLATE_INVALID, errors.join('；'), errors);
    }
    const fonds = await this.fondsRepo.findOne({ where: { id: dto.fondsId } });
    if (!fonds) throw new BizException(ErrorCode.NOT_FOUND, '全宗不存在');

    if (dto.categoryId) {
      const occupied = await this.ruleRepo.findOne({
        where: { fondsId: dto.fondsId, categoryId: dto.categoryId },
      });
      if (occupied) {
        throw new BizException(
          ErrorCode.CONFLICT,
          '该全宗与门类已存在档号规则，请直接修改原规则',
        );
      }
    }

    const saved = await this.ruleRepo.save(
      this.ruleRepo.create({
        fondsId: dto.fondsId,
        categoryId: dto.categoryId ?? null,
        segments: template.segments,
        separator: template.separator,
        resetCycle: (dto.resetCycle ?? 'YEAR') as ResetCycle,
        zeroPad: dto.zeroPad ?? 4,
        active: dto.active ?? true,
      }),
    );
    this.logger.log(`新建档号规则 ${saved.id}（${describeTemplate(template)}）`);
    return this.toDto(saved);
  }

  /** 更新规则（模板变更只影响新号） */
  public async update(dto: UpdateDanghaoRuleDto): Promise<DanghaoRuleDto> {
    const row = await this.ruleRepo.findOne({ where: { id: dto.id } });
    if (!row) throw new BizException(ErrorCode.RULE_NOT_FOUND, '档号规则不存在');

    let segments = row.segments;
    if (dto.segments) {
      segments = this.normalizeSegments(dto.segments, dto.zeroPad ?? row.zeroPad);
      assertValidTemplate({
        segments,
        separator: dto.separator ?? row.separator,
      });
    }
    await this.ruleRepo.update(
      { id: dto.id },
      {
        segments,
        separator: dto.separator ?? row.separator,
        resetCycle: (dto.resetCycle ?? row.resetCycle) as ResetCycle,
        zeroPad: dto.zeroPad ?? row.zeroPad,
        active: dto.active !== undefined ? dto.active : row.active,
        categoryId: dto.categoryId !== undefined ? dto.categoryId : row.categoryId,
      },
    );
    return this.detail(dto.id);
  }

  // ==========================================================================
  // 规则匹配
  // ==========================================================================

  /**
   * 匹配规则：门类专属 > 全宗默认 > 兜底内置模板。
   * @param fondsId 全宗 ID
   * @param categoryId 门类 ID（null/undefined 表示取全宗默认规则）
   * @param manager 可选事务管理器。**档号生成路径（generateItemDanghao /
   *   generateVolumeDanghao）必须传入**：调用方已持有事务连接，若此处再经
   *   全局连接（this.ruleRepo）读规则，会申请**第二条**池连接——并发超过
   *   池上限时全体持连接等连接，自死锁（联调现场实证，缺陷 #11：
   *   pg_stat_activity 20 会话 idle in transaction / last query START
   *   TRANSACTION / ClientRead）。传 manager 后规则读与取号同事务，
   *   单连接完成，也保证「取号时读到的规则 = 提交时生效的规则」。
   * @returns 规则实体（可能为合成的兜底规则，id 为空字符串）
   */
  public async resolveRule(
    fondsId: string,
    categoryId?: string | null,
    manager?: EntityManager,
  ): Promise<{
    template: DanghaoTemplate;
    resetCycle: ResetCycle;
    ruleId: string | null;
  }> {
    // 生成路径走事务内的 repository；非事务路径（preview/控制器）保持全局连接
    const ruleRepo = manager ? manager.getRepository(DanghaoRule) : this.ruleRepo;
    if (categoryId) {
      const byCategory = await ruleRepo.findOne({
        where: { fondsId, categoryId, active: true },
      });
      if (byCategory) {
        return {
          template: { segments: byCategory.segments, separator: byCategory.separator },
          resetCycle: byCategory.resetCycle,
          ruleId: byCategory.id,
        };
      }
    }
    const byFonds = await ruleRepo.findOne({
      where: { fondsId, categoryId: IsNull(), active: true },
      order: { createdAt: 'DESC' },
    });
    if (byFonds) {
      return {
        template: { segments: byFonds.segments, separator: byFonds.separator },
        resetCycle: byFonds.resetCycle,
        ruleId: byFonds.id,
      };
    }
    throw new BizException(
      ErrorCode.RULE_NOT_FOUND,
      '未找到适用的档号规则，请先在「档号规则配置」中为该全宗建立规则',
    );
  }

  // ==========================================================================
  // 试算（与真实生成同源）
  // ==========================================================================

  /**
   * 规则试算：不消耗真实序列号，用「当前序列 + 偏移」展示生成效果。
   * 与真实分配的差异仅在于序列值（前端明示"试算值"）。
   */
  public async preview(dto: PreviewDanghaoRequest, ruleId?: string): Promise<PreviewDanghaoResponse> {
    const fonds = await this.fondsRepo.findOne({ where: { id: dto.fondsId } });
    if (!fonds) throw new BizException(ErrorCode.NOT_FOUND, '全宗不存在');

    let template: DanghaoTemplate;
    let resetCycle: ResetCycle;
    if (ruleId) {
      const rule = await this.ruleRepo.findOne({ where: { id: ruleId } });
      if (!rule) throw new BizException(ErrorCode.RULE_NOT_FOUND, '档号规则不存在');
      template = { segments: rule.segments, separator: rule.separator };
      resetCycle = rule.resetCycle;
    } else {
      const resolved = await this.resolveRule(dto.fondsId, dto.categoryId);
      template = resolved.template;
      resetCycle = resolved.resetCycle;
    }

    const count = Math.min(Math.max(dto.count ?? 3, 1), 20);
    const retentionCode = dto.retentionCode ?? this.defaultRetentionCode();
    const orgCode = dto.orgCode ?? (await this.firstOrgCode(dto.fondsId)) ?? 'BGS';

    const baseCtx: DanghaoContext = {
      fondsNo: fonds.fondsNo,
      catalogNo: dto.catalogNo ?? '',
      year: dto.year,
      orgCode,
      retentionCode,
      volumeNo: dto.volumeNo,
      itemNo: dto.itemNo,
    };

    // 卷级作用域
    const volumeScopeKey = buildScopeKey(
      { ...template, segments: this.volumeSegmentsOnly(template.segments) },
      baseCtx,
      'VOLUME',
      resetCycle,
    );
    const nextVolume = dto.volumeNo ?? (await this.sequenceService.peek(volumeScopeKey));

    const volumeDanghao = renderDanghao(
      { ...template, segments: this.volumeSegmentsOnly(template.segments) },
      { ...baseCtx, volumeNo: nextVolume },
      { strict: false },
    );

    // 件级
    const hasItemSegment = template.segments.some((s) => s.type === 'ITEM');
    const itemScopeKey = buildScopeKey(template, { ...baseCtx, volumeNo: nextVolume }, 'ITEM', resetCycle);
    const nextItem = dto.itemNo ?? (await this.sequenceService.peek(itemScopeKey));

    const itemDanghaos: string[] = [];
    if (hasItemSegment) {
      for (let i = 0; i < count; i += 1) {
        itemDanghaos.push(
          renderDanghao(template, { ...baseCtx, volumeNo: nextVolume, itemNo: nextItem + i }, {
            strict: false,
          }),
        );
      }
    } else {
      // 无件号段时件号与卷号同号（一件一卷场景）
      itemDanghaos.push(volumeDanghao);
    }

    return {
      volumeDanghao,
      itemDanghaos,
      description: describeTemplate(template),
      volumeScopeKey,
      itemScopeKey,
    };
  }

  // ==========================================================================
  // 档号生成（供 ArchiveService 在事务内调用）
  // ==========================================================================

  /**
   * 生成件级档号（在给定事务内取号）。
   * @param manager 事务管理器（由 ArchiveService 传入，保证取号与 INSERT 同事务）。
   *   规则解析与机构代码读取**也必须经该 manager**（缺陷 #11）：否则在已持
   *   事务连接的情况下申请第二条池连接，并发超过池上限即自死锁。
   */
  public async generateItemDanghao(
    manager: EntityManager,
    params: {
      fondsId: string;
      fondsNo: string;
      categoryId?: string | null;
      year: number;
      orgCode?: string;
      retention?: Retention;
      catalogNo?: string | null;
      volumeNo?: number;
    },
  ): Promise<{ danghao: string; volumeNo: number; itemNo: number; scopeKey: string }> {
    const resolved = await this.resolveRule(params.fondsId, params.categoryId, manager);
    const template = resolved.template;
    const resetCycle = resolved.resetCycle;

    const retentionCode = this.retentionCode(params.retention ?? Retention.PERM);
    const orgCode = params.orgCode ?? (await this.firstOrgCode(params.fondsId, manager)) ?? 'BGS';

    const ctx: DanghaoContext = {
      fondsNo: params.fondsNo,
      catalogNo: params.catalogNo ?? '',
      year: params.year,
      orgCode,
      retentionCode,
      volumeNo: params.volumeNo,
    };

    // 若无卷号则先取卷序列（一件一卷场景）
    let volumeNo = params.volumeNo ?? 0;
    const hasVolumeSegment = template.segments.some((s) => s.type === 'VOLUME');
    if (hasVolumeSegment && !volumeNo) {
      const volumeScope = buildScopeKey(
        { ...template, segments: this.volumeSegmentsOnly(template.segments) },
        ctx,
        'VOLUME',
        resetCycle,
      );
      volumeNo = await this.sequenceService.nextInTransaction(manager, volumeScope);
    }

    const hasItemSegment = template.segments.some((s) => s.type === 'ITEM');
    let itemNo = 0;
    let scopeKey: string;
    if (hasItemSegment) {
      scopeKey = buildScopeKey(template, { ...ctx, volumeNo }, 'ITEM', resetCycle);
      itemNo = await this.sequenceService.nextInTransaction(manager, scopeKey);
    } else {
      scopeKey = buildScopeKey(
        { ...template, segments: this.volumeSegmentsOnly(template.segments) },
        ctx,
        'VOLUME',
        resetCycle,
      );
      itemNo = volumeNo;
    }

    const danghao = renderDanghao(template, { ...ctx, volumeNo, itemNo }, { strict: true });
    return { danghao, volumeNo, itemNo, scopeKey };
  }

  /**
   * 生成卷级档号（在给定事务内取号）。
   * @param manager 事务管理器。同 generateItemDanghao：规则/机构读取必须经该
   *   manager，禁止在持有事务连接时再申请全局连接（缺陷 #11 自死锁）。
   */
  public async generateVolumeDanghao(
    manager: EntityManager,
    params: {
      fondsId: string;
      fondsNo: string;
      categoryId?: string | null;
      year: number;
      orgCode?: string;
      retention?: Retention;
      catalogNo?: string | null;
    },
  ): Promise<{ danghao: string; volumeNo: number; scopeKey: string }> {
    const resolved = await this.resolveRule(params.fondsId, params.categoryId, manager);
    const template = {
      ...resolved.template,
      segments: this.volumeSegmentsOnly(resolved.template.segments),
    };
    const orgCode = params.orgCode ?? (await this.firstOrgCode(params.fondsId, manager)) ?? 'BGS';
    const ctx: DanghaoContext = {
      fondsNo: params.fondsNo,
      catalogNo: params.catalogNo ?? '',
      year: params.year,
      orgCode,
      retentionCode: this.retentionCode(params.retention ?? Retention.PERM),
    };
    const scopeKey = buildScopeKey(template, ctx, 'VOLUME', resolved.resetCycle);
    const volumeNo = await this.sequenceService.nextInTransaction(manager, scopeKey);
    const danghao = renderDanghao(template, { ...ctx, volumeNo }, { strict: true });
    return { danghao, volumeNo, scopeKey };
  }

  // ==========================================================================
  // 辅助
  // ==========================================================================

  /** 取模板中的卷级段（去掉 ITEM 段） */
  private volumeSegmentsOnly(segments: DanghaoSegment[]): DanghaoSegment[] {
    const filtered = segments.filter((s) => s.type !== 'ITEM');
    return filtered.length > 0 ? filtered : DEFAULT_VOLUME_TEMPLATE.segments;
  }

  /** 规范化段定义：为流水段补齐默认补零位数 */
  private normalizeSegments(segments: DanghaoSegment[], zeroPad = 4): DanghaoSegment[] {
    return (segments ?? []).map((s) => {
      const type = s.type as DanghaoSegmentType;
      const isSerial = type === 'VOLUME' || type === 'ITEM';
      return {
        type,
        pad: s.pad !== undefined ? s.pad : isSerial ? zeroPad : type === 'YEAR' ? 4 : 0,
        literal: s.literal,
        fixed: s.fixed,
      };
    });
  }

  /** 保管期限代码（DA/T 22：永久 / 30 / 10） */
  private retentionCode(retention: Retention): string {
    switch (retention) {
      case 'PERM':
        return 'Y'; // 永久
      case 'Y30':
        return '30';
      case 'Y10':
        return '10';
      default:
        return RETENTION_YEARS[retention] === -1 ? 'Y' : String(RETENTION_YEARS[retention]);
    }
  }

  private defaultRetentionCode(): string {
    return 'Y';
  }

  /** 取全宗第一个机构代码作为默认机构段（未指定时）。
   *  @param manager 档号生成路径传入的事务管理器（缺陷 #11：禁止二次取全局连接） */
  private async firstOrgCode(fondsId: string, manager?: EntityManager): Promise<string | null> {
    const orgRepo = manager ? manager.getRepository(OrgNode) : this.orgRepo;
    const org = await orgRepo.findOne({
      where: { fondsId },
      order: { sort: 'ASC', code: 'ASC' },
    });
    return org?.code ?? null;
  }

  private toDto(r: DanghaoRule): DanghaoRuleDto {
    return {
      id: r.id,
      fondsId: r.fondsId,
      categoryId: r.categoryId,
      segments: r.segments,
      separator: r.separator,
      resetCycle: r.resetCycle,
      zeroPad: r.zeroPad,
      active: r.active,
      description: describeTemplate({ segments: r.segments, separator: r.separator }),
      createdAt: new Date(r.createdAt).toISOString(),
    };
  }
}
