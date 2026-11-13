import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  ItemStatus,
  OpenFlag,
  Retention,
  SecurityLevel,
  VolumeStatus,
  type BatchUpdateItemsDto,
  type BatchUpdateResult,
  type CreateItemDto,
  type CreateVolumeDto,
  type ItemDto,
  type PageResult,
  type UpdateItemDto,
  type VoidReassignDto,
  type VoidReassignResult,
  type VolumeDto,
  type PermissionSnapshot,
} from '@tianji/shared';
import { AccessFilterBuilder } from '../../common/access/access-filter.builder';
import { BATCH_UPDATE_MAX } from '../../common/constants/enums';
import { asPartialUpdate } from '../../common/types/typeorm-helpers';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { OrgNode } from '../../infra/database/entities/org-node.entity';
import { Category } from '../../infra/database/entities/category.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { DanghaoRuleService } from '../danghao/rule.service';
import { FondsService } from '../fonds/fonds.service';
import { CategoryService } from '../category/category.service';
import { RecycleService } from '../recycle/recycle.service';

/**
 * 著录服务（F-03 案卷 / F-04 件级）。
 *
 * 硬性约束（PRD §6 合规底线）：
 *  ① 核心著录字段不可裁剪（由 CategoryService.mergeCoreFields + 必填校验保障）；
 *  ② 档号一经入库不可修改 —— 本服务的 update 显式拒绝 danghao 变更，
 *     唯一通道为 voidAndReassign（写审计 + 状态置 VOID + 生成新号）；
 *  ③ 件级著录自动继承卷级公共字段（全宗/年度/保管期限/责任者/密级）。
 */
@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Volume) private readonly volumeRepo: Repository<Volume>,
    @InjectRepository(ArchiveItem) private readonly itemRepo: Repository<ArchiveItem>,
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(OrgNode) private readonly orgRepo: Repository<OrgNode>,
    @InjectRepository(Category) private readonly categoryRepo: Repository<Category>,
    @InjectRepository(ElectronicFile) private readonly fileRepo: Repository<ElectronicFile>,
    private readonly ruleService: DanghaoRuleService,
    private readonly fondsService: FondsService,
    private readonly categoryService: CategoryService,
    private readonly recycleService: RecycleService,
    private readonly accessBuilder: AccessFilterBuilder,
  ) {}

  // ==========================================================================
  // 案卷 F-03
  // ==========================================================================

  /** 案卷列表（按全宗/年度/状态过滤） */
  public async listVolumes(params: {
    page: number;
    size: number;
    fondsId?: string;
    year?: number;
    status?: VolumeStatus;
    categoryId?: string;
    keyword?: string;
    allowedFondsIds?: string[] | null;
  }): Promise<PageResult<VolumeDto>> {
    const page = Math.max(1, params.page);
    const size = Math.min(100, Math.max(1, params.size));
    const qb = this.volumeRepo
      .createQueryBuilder('v')
      .where('v.deleted = FALSE')
      .orderBy('v.createdAt', 'DESC');

    if (params.fondsId) qb.andWhere('v.fondsId = :fondsId', { fondsId: params.fondsId });
    if (params.year) qb.andWhere('v.year = :year', { year: params.year });
    if (params.status) qb.andWhere('v.status = :status', { status: params.status });
    if (params.categoryId) qb.andWhere('v.categoryId = :categoryId', { categoryId: params.categoryId });
    if (params.keyword) {
      qb.andWhere('(v.title ILIKE :kw OR v.danghao ILIKE :kw OR v.responsible ILIKE :kw)', {
        kw: `%${params.keyword}%`,
      });
    }
    if (params.allowedFondsIds !== null && params.allowedFondsIds !== undefined) {
      if (params.allowedFondsIds.length === 0) return { list: [], total: 0, page, size };
      qb.andWhere('v.fondsId IN (:...allowed)', { allowed: params.allowedFondsIds });
    }

    qb.skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();
    return { list: rows.map((r) => this.toVolumeDto(r)), total, page, size };
  }

  /** 案卷详情 */
  public async volumeDetail(id: string, user?: PermissionSnapshot): Promise<VolumeDto> {
    const row = await this.volumeRepo.findOne({ where: { id, deleted: false } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '案卷不存在');
    if (user && !this.accessBuilder.canAccessRecord(user, row)) {
      throw new BizException(ErrorCode.FORBIDDEN, '密级或数据范围不足，无法查看该案卷');
    }
    return this.toVolumeDto(row);
  }

  /**
   * 新建案卷：服务端分配档号（事务内取号 + INSERT，失败一起回滚）。
   */
  public async createVolume(dto: CreateVolumeDto, userId: string): Promise<VolumeDto> {
    const fonds = await this.fondsService.assertFondsActive(dto.fondsId);
    const fields = dto.categoryId ? await this.categoryService.volumeFields(dto.categoryId) : [];
    const validationErrors = this.categoryService.validatePayload(
      fields.filter((f) => f.key !== 'danghao'),
      dto as unknown as Record<string, unknown>,
      'VOLUME',
    );
    if (validationErrors.length > 0) {
      throw new BizException(ErrorCode.VALIDATION_FAILED, validationErrors.join('；'), validationErrors);
    }

    const org = dto.orgId ? await this.orgRepo.findOne({ where: { id: dto.orgId } }) : null;

    return this.dataSource.transaction(async (manager) => {
      const generated = await this.ruleService.generateVolumeDanghao(manager, {
        fondsId: dto.fondsId,
        fondsNo: fonds.fondsNo,
        categoryId: dto.categoryId ?? null,
        year: dto.year,
        orgCode: org?.code,
        retention: dto.retention,
        catalogNo: dto.catalogNo ?? null,
      });

      const entity = manager.create(Volume, {
        fondsId: dto.fondsId,
        categoryId: dto.categoryId ?? null,
        orgId: dto.orgId ?? null,
        danghao: generated.danghao,
        title: dto.title,
        responsible: dto.responsible ?? null,
        year: dto.year,
        retention: dto.retention ?? Retention.PERM,
        securityLevel: dto.securityLevel ?? SecurityLevel.PUBLIC,
        itemCount: 0,
        startDate: dto.startDate ?? null,
        endDate: dto.endDate ?? null,
        classNo: dto.classNo ?? null,
        keywords: dto.keywords ?? [],
        note: dto.note ?? null,
        status: VolumeStatus.DRAFT,
        extra: dto.extra ?? {},
        deleted: false,
        createdBy: userId,
      });
      const saved = await manager.save(entity);
      this.logger.log(`新建案卷 ${saved.danghao}（题目：${saved.title}）`);
      return this.toVolumeDto(saved);
    });
  }

  /** 更新案卷（档号不可改） */
  public async updateVolume(
    id: string,
    patch: Partial<CreateVolumeDto> & { danghao?: string },
  ): Promise<VolumeDto> {
    const row = await this.volumeRepo.findOne({ where: { id, deleted: false } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '案卷不存在');
    if (patch.danghao && patch.danghao !== row.danghao) {
      throw new BizException(ErrorCode.DANGHAO_IMMUTABLE);
    }
    if (row.status === VolumeStatus.VOID) {
      throw new BizException(ErrorCode.BAD_REQUEST, '已作废案卷不可修改');
    }

    await this.volumeRepo.update(
      { id },
      asPartialUpdate<Volume>({
        title: patch.title ?? row.title,
        responsible: patch.responsible !== undefined ? patch.responsible : row.responsible,
        retention: patch.retention ?? row.retention,
        securityLevel: patch.securityLevel ?? row.securityLevel,
        startDate: patch.startDate !== undefined ? patch.startDate : row.startDate,
        endDate: patch.endDate !== undefined ? patch.endDate : row.endDate,
        classNo: patch.classNo !== undefined ? patch.classNo : row.classNo,
        keywords: patch.keywords ?? row.keywords,
        note: patch.note !== undefined ? patch.note : row.note,
        extra: patch.extra ?? row.extra,
      }),
    );
    return this.volumeDetail(id);
  }

  /**
   * 案卷归档确认：DRAFT → ARCHIVED，并同步卷内件状态。
   *
   * 并发防护：锁内重读 + CAS（WHERE 带读取时的 status）。
   * 原实现锁外读状态、事务内无条件写，两人同时确认会重复推进；
   * 更要紧的是与「作废重编」并发时，已 VOID 的案卷可能被重新置为 ARCHIVED。
   */
  public async confirmVolume(id: string): Promise<VolumeDto> {
    return this.withItemLock(`volume:${id}`, async () => {
      const row = await this.volumeRepo.findOne({ where: { id, deleted: false } });
      if (!row) throw new BizException(ErrorCode.NOT_FOUND, '案卷不存在');
      if (row.status === VolumeStatus.VOID) {
        throw new BizException(ErrorCode.BAD_REQUEST, '已作废案卷不可归档');
      }
      await this.dataSource.transaction(async (manager) => {
        const cas = await manager.update(
          Volume,
          { id, status: row.status },
          { status: VolumeStatus.ARCHIVED },
        );
        if (!cas.affected) {
          throw new BizException(ErrorCode.CONFLICT, '该案卷已被他人处理，请刷新后重试');
        }
        await manager.update(
          ArchiveItem,
          { volumeId: id, status: In([ItemStatus.DRAFT, ItemStatus.SUBMITTED]) },
          { status: ItemStatus.ARCHIVED },
        );
      });
      return this.volumeDetail(id);
    });
  }

  // ==========================================================================
  // 件级 F-04
  // ==========================================================================

  /** 件列表（按案卷或按全宗） */
  public async listItems(params: {
    page: number;
    size: number;
    volumeId?: string;
    fondsId?: string;
    year?: number;
    status?: ItemStatus;
    keyword?: string;
    allowedFondsIds?: string[] | null;
    /** 传入时按密级+数据范围行级过滤（检索利用链路） */
    user?: PermissionSnapshot;
  }): Promise<PageResult<ItemDto>> {
    const page = Math.max(1, params.page);
    const size = Math.min(100, Math.max(1, params.size));
    const qb = this.itemRepo
      .createQueryBuilder('i')
      .where('i.deleted = FALSE')
      .orderBy('i.danghao', 'ASC');

    if (params.volumeId) qb.andWhere('i.volumeId = :volumeId', { volumeId: params.volumeId });
    if (params.fondsId) qb.andWhere('i.fondsId = :fondsId', { fondsId: params.fondsId });
    if (params.year) qb.andWhere('i.year = :year', { year: params.year });
    if (params.status) qb.andWhere('i.status = :status', { status: params.status });
    if (params.keyword) {
      qb.andWhere('(i.title ILIKE :kw OR i.danghao ILIKE :kw OR i.responsible ILIKE :kw)', {
        kw: `%${params.keyword}%`,
      });
    }
    if (params.allowedFondsIds !== null && params.allowedFondsIds !== undefined) {
      if (params.allowedFondsIds.length === 0) return { list: [], total: 0, page, size };
      qb.andWhere('i.fondsId IN (:...allowed)', { allowed: params.allowedFondsIds });
    }
    if (params.user) {
      const levels = this.accessBuilder.levelsAtMost(params.user.maxSecurityLevel);
      if (levels.length === 0) return { list: [], total: 0, page, size };
      qb.andWhere('i.securityLevel IN (:...levels)', { levels });
      if (params.user.fondsIds !== null) {
        if (params.user.fondsIds.length === 0) return { list: [], total: 0, page, size };
        qb.andWhere('i.fondsId IN (:...scopeFonds)', { scopeFonds: params.user.fondsIds });
      }
    }

    qb.skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();

    // 批量统计文件数，避免 N+1
    const ids = rows.map((r) => r.id);
    const fileCounts = await this.countFilesByItems(ids);

    return {
      list: rows.map((r) => this.toItemDto(r, fileCounts.get(r.id) ?? 0)),
      total,
      page,
      size,
    };
  }

  /** 件详情 */
  /** 件详情（传入 user 时做密级+数据范围行级校验——检索利用链路的唯一防线） */
  public async itemDetail(id: string, user?: PermissionSnapshot): Promise<ItemDto> {
    const row = await this.itemRepo.findOne({ where: { id, deleted: false } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');
    if (user && !this.accessBuilder.canAccessRecord(user, row)) {
      throw new BizException(ErrorCode.FORBIDDEN, '密级或数据范围不足，无法查看该档案');
    }
    const fileCount = await this.fileRepo.count({ where: { itemId: id } });
    return this.toItemDto(row, fileCount);
  }

  /**
   * 卷内新增件：自动继承卷级公共字段（全宗、年度、保管期限、责任者、密级），服务端分配档号。
   */
  public async createItemInVolume(
    volumeId: string,
    dto: CreateItemDto,
    userId: string,
  ): Promise<ItemDto> {
    const volume = await this.volumeRepo.findOne({ where: { id: volumeId, deleted: false } });
    if (!volume) throw new BizException(ErrorCode.NOT_FOUND, '案卷不存在');
    if (volume.status === VolumeStatus.VOID) {
      throw new BizException(ErrorCode.BAD_REQUEST, '已作废案卷不可新增件');
    }
    const fonds = await this.fondsService.assertFondsActive(volume.fondsId);

    // 必填校验（门类字段集）
    const fields = volume.categoryId
      ? await this.categoryService.itemFields(volume.categoryId)
      : [];
    const effective = this.applyVolumeInheritance(dto, volume);
    const errors = this.categoryService.validatePayload(
      fields.filter((f) => f.key !== 'danghao'),
      effective as unknown as Record<string, unknown>,
      'ITEM',
    );
    if (errors.length > 0) {
      throw new BizException(ErrorCode.VALIDATION_FAILED, errors.join('；'), errors);
    }

    const org = volume.orgId ? await this.orgRepo.findOne({ where: { id: volume.orgId } }) : null;

    return this.dataSource.transaction(async (manager) => {
      const generated = await this.ruleService.generateItemDanghao(manager, {
        fondsId: volume.fondsId,
        fondsNo: fonds.fondsNo,
        categoryId: volume.categoryId,
        year: effective.year ?? volume.year,
        orgCode: org?.code,
        retention: effective.retention ?? volume.retention,
        volumeNo: undefined,
      });

      // 卷内序号：优先使用档号流水，若规则无 ITEM 段则按当前件数 +1
      const entity = manager.create(ArchiveItem, {
        volumeId,
        fondsId: volume.fondsId,
        danghao: generated.danghao,
        title: effective.title,
        responsible: effective.responsible ?? volume.responsible,
        docNo: effective.docNo ?? null,
        docDate: effective.docDate ?? null,
        year: effective.year ?? volume.year,
        retention: (effective.retention ?? volume.retention) as Retention,
        securityLevel: (effective.securityLevel ?? volume.securityLevel) as SecurityLevel,
        categoryCode: effective.categoryCode ?? null,
        classNo: effective.classNo ?? volume.classNo,
        keywords: effective.keywords ?? [],
        pages: effective.pages ?? null,
        note: effective.note ?? null,
        status: ItemStatus.DRAFT,
        openFlag: effective.openFlag ?? OpenFlag.CONTROLLED,
        extra: effective.extra ?? {},
        deleted: false,
        createdBy: userId,
      });
      const saved = await manager.save(entity);

      // 同步卷内件数
      await manager.increment(Volume, { id: volumeId }, 'itemCount', 1);

      this.logger.log(`卷 ${volume.danghao} 新增件 ${saved.danghao}`);
      return this.toItemDto(saved, 0);
    });
  }

  /**
   * 独立新增件（不归属案卷，一件一卷场景）。
   */
  public async createItem(dto: CreateItemDto & { fondsId: string; categoryId?: string; orgId?: string }, userId: string): Promise<ItemDto> {
    const fonds = await this.fondsService.assertFondsActive(dto.fondsId);
    if (!dto.title || !dto.responsible || !dto.docDate) {
      throw new BizException(
        ErrorCode.VALIDATION_FAILED,
        '件级必填字段缺失：文件题名、责任者、形成日期为必填',
      );
    }
    const org = dto.orgId ? await this.orgRepo.findOne({ where: { id: dto.orgId } }) : null;
    const year = dto.year ?? new Date(dto.docDate).getFullYear();

    return this.dataSource.transaction(async (manager) => {
      const generated = await this.ruleService.generateItemDanghao(manager, {
        fondsId: dto.fondsId,
        fondsNo: fonds.fondsNo,
        categoryId: dto.categoryId ?? null,
        year,
        orgCode: org?.code,
        retention: dto.retention,
      });

      const entity = manager.create(ArchiveItem, {
        volumeId: null,
        fondsId: dto.fondsId,
        danghao: generated.danghao,
        title: dto.title,
        responsible: dto.responsible,
        docNo: dto.docNo ?? null,
        docDate: dto.docDate,
        year,
        retention: dto.retention ?? Retention.PERM,
        securityLevel: dto.securityLevel ?? SecurityLevel.PUBLIC,
        categoryCode: dto.categoryCode ?? null,
        classNo: dto.classNo ?? null,
        keywords: dto.keywords ?? [],
        pages: dto.pages ?? null,
        note: dto.note ?? null,
        status: ItemStatus.DRAFT,
        openFlag: dto.openFlag ?? OpenFlag.CONTROLLED,
        extra: dto.extra ?? {},
        deleted: false,
        createdBy: userId,
      });
      const saved = await manager.save(entity);
      return this.toItemDto(saved, 0);
    });
  }

  /** 更新件（档号不可改；已归档件仅允许有限字段） */
  public async updateItem(dto: UpdateItemDto): Promise<ItemDto> {
    const row = await this.itemRepo.findOne({ where: { id: dto.id, deleted: false } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');

    const payload = dto as unknown as Record<string, unknown>;
    if (payload.danghao !== undefined && payload.danghao !== row.danghao) {
      throw new BizException(ErrorCode.DANGHAO_IMMUTABLE);
    }
    if (row.status === ItemStatus.VOID) {
      throw new BizException(ErrorCode.BAD_REQUEST, '已作废条目不可修改，请新增条目');
    }

    await this.itemRepo.update(
      { id: dto.id },
      asPartialUpdate<ArchiveItem>({
        title: dto.title ?? row.title,
        responsible: dto.responsible !== undefined ? dto.responsible : row.responsible,
        docNo: dto.docNo !== undefined ? dto.docNo : row.docNo,
        docDate: dto.docDate !== undefined ? dto.docDate : row.docDate,
        retention: dto.retention ?? row.retention,
        securityLevel: dto.securityLevel ?? row.securityLevel,
        categoryCode: dto.categoryCode !== undefined ? dto.categoryCode : row.categoryCode,
        classNo: dto.classNo !== undefined ? dto.classNo : row.classNo,
        keywords: dto.keywords ?? row.keywords,
        pages: dto.pages !== undefined ? dto.pages : row.pages,
        note: dto.note !== undefined ? dto.note : row.note,
        openFlag: dto.openFlag ?? row.openFlag,
        extra: dto.extra ?? row.extra,
      }),
    );
    return this.itemDetail(dto.id);
  }

  /**
   * 提交归档（R2 部门档案员仅能提交，由 R1 确认）。
   * 并发防护：CAS（WHERE status=DRAFT），重复提交/与作废并发时不会互相覆盖。
   */
  public async submitItem(id: string): Promise<ItemDto> {
    const row = await this.itemRepo.findOne({ where: { id, deleted: false } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');
    if (row.status !== ItemStatus.DRAFT) {
      throw new BizException(ErrorCode.BAD_REQUEST, '仅草稿状态可提交归档');
    }
    const cas = await this.itemRepo.update(
      { id, status: ItemStatus.DRAFT },
      { status: ItemStatus.SUBMITTED },
    );
    if (!cas.affected) {
      throw new BizException(ErrorCode.CONFLICT, '该条目状态已变更，请刷新后重试');
    }
    return this.itemDetail(id);
  }

  /** 归档确认（R1）：SUBMITTED/DRAFT → ARCHIVED */
  public async confirmItems(ids: string[]): Promise<{ confirmed: number }> {
    if (!ids || ids.length === 0) throw new BizException(ErrorCode.BAD_REQUEST, '请选择要归档的条目');
    const result = await this.itemRepo
      .createQueryBuilder()
      .update(ArchiveItem)
      .set({ status: ItemStatus.ARCHIVED })
      .where('id IN (:...ids)', { ids })
      .andWhere('deleted = FALSE')
      .andWhere('status IN (:...states)', { states: [ItemStatus.DRAFT, ItemStatus.SUBMITTED] })
      .execute();
    return { confirmed: result.affected ?? 0 };
  }

  /**
   * 批量修改（NFR-7：≥500 条 <30s）。
   * 使用单条 UPDATE ... WHERE id = ANY(...) 完成，避免逐条往返。
   */
  public async batchUpdate(dto: BatchUpdateItemsDto): Promise<BatchUpdateResult> {
    if (!Array.isArray(dto.ids) || dto.ids.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '请选择要修改的条目');
    }
    if (dto.ids.length > BATCH_UPDATE_MAX) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `单次批量修改不得超过 ${BATCH_UPDATE_MAX} 条`,
      );
    }
    const patch = dto.patch ?? {};
    if ((patch as Record<string, unknown>).danghao !== undefined) {
      throw new BizException(ErrorCode.DANGHAO_IMMUTABLE, '批量修改不允许变更档号');
    }

    const setClauses: string[] = [];
    const params: Record<string, unknown> = { ids: dto.ids };
    const assignable: Array<keyof CreateItemDto> = [
      'title',
      'responsible',
      'docNo',
      'docDate',
      'retention',
      'securityLevel',
      'categoryCode',
      'classNo',
      'keywords',
      'pages',
      'note',
      'openFlag',
    ];
    for (const key of assignable) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) {
        params[key] = value;
        setClauses.push(`"${this.camelToSnake(key)}" = :${key}`);
      }
    }
    if (setClauses.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '未提供任何可修改字段');
    }
    setClauses.push(`"updated_at" = now()`);

    const result = await this.itemRepo.query(
      `UPDATE "archive_item" SET ${setClauses.join(', ')}
        WHERE "id" = ANY($1::uuid[]) AND "deleted" = FALSE AND "status" <> 'VOID'`,
      [dto.ids],
    );

    // 校验失败项：VOID/不存在
    const existing = await this.itemRepo.find({
      where: { id: In(dto.ids) },
      select: ['id', 'status', 'deleted'],
    });
    const okSet = new Set(
      existing.filter((e) => !e.deleted && e.status !== ItemStatus.VOID).map((e) => e.id),
    );
    const failed = dto.ids
      .filter((id) => !okSet.has(id))
      .map((id) => ({ id, reason: '条目不存在或已作废/已删除' }));

    return {
      requested: dto.ids.length,
      updated: Array.isArray(result) ? result.length : (result as { rowCount?: number })?.rowCount ?? okSet.size,
      failed,
    };
  }

  /**
   * 作废重编 —— 档号唯一可变通道（PRD 合规底线②）。
   *
   * 流程（单事务）：
   *   1) 原子置旧档号为作废标记（`danghao` 改为 `<old>~VOID~<timestamp>`，释放唯一键，
   *      同时保留可追溯性）；
   *   2) 若 reassign=true，按当前规则生成新档号并写回；
   *   3) 状态置 VOID（未重编时）或保持原状态（重编后为 DRAFT 需重新归档）；
   *   审计由 Controller 层 AuditLogInterceptor 记录（含新旧档号）。
   */
  public async voidAndReassign(
    id: string,
    dto: VoidReassignDto,
    userId: string,
  ): Promise<VoidReassignResult> {
    if (!dto.reason || dto.reason.trim().length < 2) {
      throw new BizException(ErrorCode.BAD_REQUEST, '作废重编必须填写原因（不少于 2 字）');
    }

    // 并发防护：整个「读取 → 判定 → 作废 → 取新号 → 写回」在单据互斥锁内完成。
    //
    // 只做「锁外读 + 锁内写」会有两类问题：
    //  ① 双击「作废重编」：两个请求都读到 status=DRAFT（未作废），各自取一个新号，
    //     结果同一条目被重编两次，白白消耗两个档号，且历史 chain 里出现两条记录；
    //  ② 与「归档确认」并发：确认刚把状态推到 ACTIVE，作废仍按旧快照 DRAFT 执行。
    //
    // 档号取号原子性已由 DanghaoSequenceService 保证（同事务内
    // `INSERT ON CONFLICT DO NOTHING` + `UPDATE ... RETURNING`，行锁串行化），
    // 本锁不替代它，只是避免同一单据被重复处理。
    return this.withItemLock(id, async () => {
      const row = await this.itemRepo.findOne({ where: { id, deleted: false } });
      if (!row) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');
      if (row.status === ItemStatus.VOID) {
        throw new BizException(ErrorCode.BAD_REQUEST, '该条目已作废，不可重复作废');
      }
      const oldDanghao = row.danghao;
      const expectedStatus = row.status;
      const fonds = await this.fondsRepo.findOne({ where: { id: row.fondsId } });
      if (!fonds) throw new BizException(ErrorCode.NOT_FOUND, '全宗不存在');
      const category = row.categoryCode
        ? await this.categoryRepo.findOne({ where: { code: row.categoryCode } })
        : null;
      const org = row.volumeId
        ? await this.volumeRepo.findOne({ where: { id: row.volumeId } })
        : null;
      const orgCode = org?.orgId
        ? (await this.orgRepo.findOne({ where: { id: org.orgId } }))?.code
        : undefined;

      const reassign = dto.reassign !== false;

      return this.dataSource.transaction(async (manager: EntityManager) => {
        // 1) 释放旧档号唯一键（保留追溯痕迹）。
        //    WHERE 带上 status：万一有旁路（不走本锁的批量脚本）改了状态，这里会落空，
        //    我们据此拒绝，而不是把别人的改动覆盖掉。
        const voidMark = `${oldDanghao}~VOID~${Date.now()}`.slice(0, 120);
        const released = await manager.update(
          ArchiveItem,
          { id, status: expectedStatus, danghao: oldDanghao },
          { danghao: voidMark },
        );
        if (!released.affected) {
          throw new BizException(
            ErrorCode.CONFLICT,
            '该条目已被他人处理（状态或档号已变更），请刷新后重试',
          );
        }

        let newDanghao: string | null = null;
        if (reassign) {
          // 取号与写回在同一事务：序列自增失败会整体回滚，不会出现「号被消耗但没写回」
          const generated = await this.ruleService.generateItemDanghao(manager, {
            fondsId: row.fondsId,
            fondsNo: fonds.fondsNo,
            categoryId: category?.id ?? null,
            year: row.year,
            orgCode,
            retention: row.retention,
          });
          newDanghao = generated.danghao;
        }

        await manager.update(
          ArchiveItem,
          { id },
          {
            danghao: newDanghao ?? voidMark,
            status: newDanghao ? ItemStatus.DRAFT : ItemStatus.VOID,
            extra: {
              ...(row.extra ?? {}),
              voidHistory: [
                ...((row.extra?.voidHistory as unknown[]) ?? []),
                {
                  oldDanghao,
                  newDanghao,
                  reason: dto.reason,
                  operatorId: userId,
                  at: new Date().toISOString(),
                },
              ],
            },
          },
        );

        this.logger.warn(
          `档号作废重编: ${oldDanghao} -> ${newDanghao ?? '(未重编)'} 原因=${dto.reason} 操作人=${userId}`,
        );

        return {
          id,
          oldDanghao,
          newDanghao,
          status: newDanghao ? ItemStatus.DRAFT : ItemStatus.VOID,
        };
      });
    });
  }

  // ==========================================================================
  // 并发控制
  // ==========================================================================

  /** 按条目粒度的进程内互斥锁表（单实例消除同条目并发；多实例由 DB 行锁/CAS 兜底） */
  private readonly itemLocks = new Map<string, Promise<void>>();

  /**
   * 以条目 ID 为粒度串行执行任务（与 BorrowService.withOrderLock 同构）。
   *
   * 说明：进程内锁只解决单实例并发；真正的多实例正确性依赖
   * ① 档号序列的 `UPDATE ... RETURNING` 行锁；② update 语句携带 status 的 CAS 语义。
   */
  private async withItemLock<T>(itemId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.itemLocks.get(itemId) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.itemLocks.set(itemId, tail);

    await prev;
    try {
      return await task();
    } finally {
      release();
      if (this.itemLocks.get(itemId) === tail) {
        this.itemLocks.delete(itemId);
      }
    }
  }

  /** 软删除件（进回收站，由 RecycleModule 记录） */
  public async softDeleteItem(
    id: string,
    operatorId: string | null = null,
  ): Promise<{ deleted: boolean; label: string }> {
    const row = await this.itemRepo.findOne({ where: { id, deleted: false } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '档案条目不存在');
    await this.itemRepo.update({ id }, { deleted: true });
    if (row.volumeId) {
      await this.volumeRepo.decrement({ id: row.volumeId }, 'itemCount', 1);
    }
    // 入回收站（F-18）：保留 30 天，可还原
    const label = `${row.danghao} ${row.title}`;
    await this.recycleService.record({
      objectType: 'ITEM',
      objectId: row.id,
      objectLabel: label,
      snapshot: {
        danghao: row.danghao,
        title: row.title,
        volumeId: row.volumeId,
        status: row.status,
        securityLevel: row.securityLevel,
      },
      deletedBy: operatorId,
    });
    return { deleted: true, label };
  }

  /** 软删除案卷 */
  public async softDeleteVolume(
    id: string,
    operatorId: string | null = null,
  ): Promise<{ deleted: boolean; label: string }> {
    const row = await this.volumeRepo.findOne({ where: { id, deleted: false } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '案卷不存在');
    await this.dataSource.transaction(async (manager) => {
      await manager.update(Volume, { id }, { deleted: true });
      await manager.update(ArchiveItem, { volumeId: id }, { deleted: true });
    });
    // 入回收站（F-18）：整卷（含卷内件）一并登记
    const label = `${row.danghao} ${row.title}`;
    await this.recycleService.record({
      objectType: 'VOLUME',
      objectId: row.id,
      objectLabel: label,
      snapshot: {
        danghao: row.danghao,
        title: row.title,
        year: row.year,
        retention: row.retention,
        itemCount: row.itemCount,
      },
      deletedBy: operatorId,
    });
    return { deleted: true, label };
  }

  // ==========================================================================
  // 内部辅助
  // ==========================================================================

  /** 卷内件继承卷级公共字段 */
  private applyVolumeInheritance(dto: CreateItemDto, volume: Volume): CreateItemDto {
    return {
      ...dto,
      responsible: dto.responsible || volume.responsible || '',
      year: dto.year ?? volume.year,
      retention: dto.retention ?? (volume.retention as Retention),
      securityLevel: dto.securityLevel ?? (volume.securityLevel as SecurityLevel),
      classNo: dto.classNo ?? volume.classNo ?? null,
      keywords: dto.keywords && dto.keywords.length > 0 ? dto.keywords : volume.keywords,
    };
  }

  /** 批量统计件下的文件数 */
  private async countFilesByItems(itemIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (itemIds.length === 0) return map;
    const rows: Array<{ item_id: string; cnt: string }> = await this.fileRepo.query(
      `SELECT item_id, COUNT(*)::text AS cnt FROM electronic_file WHERE item_id = ANY($1::uuid[]) GROUP BY item_id`,
      [itemIds],
    );
    for (const r of rows) map.set(r.item_id, Number.parseInt(r.cnt, 10));
    return map;
  }

  private camelToSnake(key: string): string {
    return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  }

  public toVolumeDto(r: Volume): VolumeDto {
    return {
      id: r.id,
      fondsId: r.fondsId,
      categoryId: r.categoryId,
      orgId: r.orgId,
      danghao: r.danghao,
      title: r.title,
      responsible: r.responsible,
      year: r.year,
      retention: r.retention,
      securityLevel: r.securityLevel,
      itemCount: r.itemCount,
      startDate: r.startDate,
      endDate: r.endDate,
      classNo: r.classNo,
      keywords: Array.isArray(r.keywords) ? r.keywords : [],
      note: r.note,
      status: r.status,
      extra: r.extra ?? {},
      createdBy: r.createdBy,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }

  public toItemDto(r: ArchiveItem, fileCount = 0): ItemDto {
    return {
      id: r.id,
      volumeId: r.volumeId,
      fondsId: r.fondsId,
      danghao: r.danghao,
      title: r.title,
      responsible: r.responsible,
      docNo: r.docNo,
      docDate: r.docDate,
      year: r.year,
      retention: r.retention,
      securityLevel: r.securityLevel,
      categoryCode: r.categoryCode,
      classNo: r.classNo,
      keywords: Array.isArray(r.keywords) ? r.keywords : [],
      pages: r.pages,
      note: r.note,
      status: r.status,
      openFlag: r.openFlag,
      fullText: null,
      extra: r.extra ?? {},
      fileCount,
      createdBy: r.createdBy,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }
}
