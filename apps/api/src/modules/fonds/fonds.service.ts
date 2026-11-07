import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  FondsStatus,
  type CreateFondsDto,
  type CreateOrgNodeDto,
  type FondsDto,
  type OrgNodeDto,
  type PageResult,
  type UpdateFondsDto,
} from '@tianji/shared';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { OrgNode } from '../../infra/database/entities/org-node.entity';

/**
 * 全宗管理服务（F-01，DA/T 22-2015 §5.2）。
 * - 全宗号全局唯一；
 * - 停用全宗不可新增档案但可检索；
 * - 全宗下维护组织机构树（供档号机构段与数据范围授权使用）。
 */
@Injectable()
export class FondsService {
  private readonly logger = new Logger(FondsService.name);

  constructor(
    @InjectRepository(Fonds) private readonly fondsRepo: Repository<Fonds>,
    @InjectRepository(OrgNode) private readonly orgRepo: Repository<OrgNode>,
  ) {}

  /** 全宗列表 */
  public async list(params: {
    page: number;
    size: number;
    keyword?: string;
    status?: FondsStatus;
    allowedFondsIds?: string[] | null;
  }): Promise<PageResult<FondsDto>> {
    const page = Math.max(1, params.page);
    const size = Math.min(100, Math.max(1, params.size));
    const qb = this.fondsRepo.createQueryBuilder('f').orderBy('f.fondsNo', 'ASC');

    if (params.keyword) {
      qb.andWhere('(f.fondsNo ILIKE :kw OR f.name ILIKE :kw OR f.orgName ILIKE :kw)', {
        kw: `%${params.keyword}%`,
      });
    }
    if (params.status) qb.andWhere('f.status = :status', { status: params.status });
    // 数据范围：仅可见授权全宗（null 表示不限）
    if (params.allowedFondsIds !== null && params.allowedFondsIds !== undefined) {
      if (params.allowedFondsIds.length === 0) {
        return { list: [], total: 0, page, size };
      }
      qb.andWhere('f.id IN (:...allowed)', { allowed: params.allowedFondsIds });
    }

    qb.skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();
    return { list: rows.map((r) => this.toDto(r)), total, page, size };
  }

  /** 全宗详情 */
  public async detail(id: string): Promise<FondsDto> {
    const row = await this.fondsRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '全宗不存在');
    return this.toDto(row);
  }

  /** 新建全宗 */
  public async create(dto: CreateFondsDto): Promise<FondsDto> {
    if (!dto.fondsNo || !dto.name) {
      throw new BizException(ErrorCode.BAD_REQUEST, '全宗号与全宗名称不能为空');
    }
    if (!/^[A-Za-z0-9]{1,32}$/.test(dto.fondsNo)) {
      throw new BizException(ErrorCode.BAD_REQUEST, '全宗号仅允许字母与数字，长度 1~32');
    }
    if (dto.yearStart && dto.yearEnd && dto.yearStart > dto.yearEnd) {
      throw new BizException(ErrorCode.BAD_REQUEST, '起始年度不能大于终止年度');
    }
    const dup = await this.fondsRepo.findOne({ where: { fondsNo: dto.fondsNo } });
    if (dup) throw new BizException(ErrorCode.CONFLICT, `全宗号「${dto.fondsNo}」已存在`);

    const saved = await this.fondsRepo.save(
      this.fondsRepo.create({
        fondsNo: dto.fondsNo,
        name: dto.name,
        orgName: dto.orgName ?? null,
        yearStart: dto.yearStart ?? null,
        yearEnd: dto.yearEnd ?? null,
        status: dto.status ?? FondsStatus.ACTIVE,
        historyNote: dto.historyNote ?? null,
      }),
    );
    this.logger.log(`新建全宗 ${saved.fondsNo} - ${saved.name}`);
    return this.toDto(saved);
  }

  /** 更新全宗（全宗号不可改，避免破坏历史档号） */
  public async update(dto: UpdateFondsDto): Promise<FondsDto> {
    const row = await this.fondsRepo.findOne({ where: { id: dto.id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '全宗不存在');
    if (dto.fondsNo && dto.fondsNo !== row.fondsNo) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        '全宗号一经建立不可修改（已参与档号生成），如需变更请新建全宗并做数据迁移',
      );
    }
    await this.fondsRepo.update(
      { id: dto.id },
      {
        name: dto.name ?? row.name,
        orgName: dto.orgName !== undefined ? dto.orgName : row.orgName,
        yearStart: dto.yearStart !== undefined ? dto.yearStart : row.yearStart,
        yearEnd: dto.yearEnd !== undefined ? dto.yearEnd : row.yearEnd,
        status: dto.status ?? row.status,
        historyNote: dto.historyNote !== undefined ? dto.historyNote : row.historyNote,
      },
    );
    return this.detail(dto.id);
  }

  /** 校验全宗可用于新增档案（停用不可新增） */
  public async assertFondsActive(fondsId: string): Promise<Fonds> {
    const fonds = await this.fondsRepo.findOne({ where: { id: fondsId } });
    if (!fonds) throw new BizException(ErrorCode.NOT_FOUND, '全宗不存在');
    if (fonds.status === FondsStatus.DISABLED) {
      throw new BizException(ErrorCode.FONDS_DISABLED, `全宗「${fonds.name}」已停用，不允许新增档案`);
    }
    return fonds;
  }

  // ==========================================================================
  // 机构树
  // ==========================================================================

  /** 机构树（按全宗） */
  public async orgTree(fondsId: string): Promise<OrgNodeDto[]> {
    const rows = await this.orgRepo.find({
      where: { fondsId },
      order: { sort: 'ASC', code: 'ASC' },
    });
    const map = new Map<string, OrgNodeDto>();
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        fondsId: r.fondsId,
        parentId: r.parentId,
        code: r.code,
        name: r.name,
        children: [],
      });
    }
    const roots: OrgNodeDto[] = [];
    for (const node of map.values()) {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)?.children?.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /** 新增机构节点 */
  public async createOrg(dto: CreateOrgNodeDto): Promise<OrgNodeDto> {
    await this.assertFondsExists(dto.fondsId);
    if (dto.parentId) {
      const parent = await this.orgRepo.findOne({ where: { id: dto.parentId } });
      if (!parent) throw new BizException(ErrorCode.NOT_FOUND, '上级机构不存在');
      if (parent.fondsId !== dto.fondsId) {
        throw new BizException(ErrorCode.BAD_REQUEST, '上级机构不属于同一全宗');
      }
    }
    const dup = await this.orgRepo.findOne({
      where: { fondsId: dto.fondsId, code: dto.code },
    });
    if (dup) throw new BizException(ErrorCode.CONFLICT, `机构代码「${dto.code}」在本全宗内已存在`);

    const saved = await this.orgRepo.save(
      this.orgRepo.create({
        fondsId: dto.fondsId,
        parentId: dto.parentId ?? null,
        code: dto.code,
        name: dto.name,
        sort: 0,
      }),
    );
    return {
      id: saved.id,
      fondsId: saved.fondsId,
      parentId: saved.parentId,
      code: saved.code,
      name: saved.name,
      children: [],
    };
  }

  /** 按机构代码查机构（档号机构段解析用） */
  public async findOrgByCode(fondsId: string, code: string): Promise<OrgNode | null> {
    return this.orgRepo.findOne({ where: { fondsId, code } });
  }

  /** 机构是否存在 */
  public async orgExists(orgId: string): Promise<OrgNode | null> {
    return this.orgRepo.findOne({ where: { id: orgId } });
  }

  private async assertFondsExists(fondsId: string): Promise<void> {
    const exists = await this.fondsRepo.findOne({ where: { id: fondsId } });
    if (!exists) throw new BizException(ErrorCode.NOT_FOUND, '全宗不存在');
  }

  private toDto(r: Fonds): FondsDto {
    return {
      id: r.id,
      fondsNo: r.fondsNo,
      name: r.name,
      orgName: r.orgName,
      yearStart: r.yearStart,
      yearEnd: r.yearEnd,
      status: r.status,
      historyNote: r.historyNote,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }
}
