import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  getParamDef,
  validateParamValue,
  type DictItemDto,
  type SystemParamDto,
  type UpsertDictItemDto,
  type UpsertParamDto,
} from '@tianji/shared';
import { DictItem } from '../../infra/database/entities/dict-item.entity';
import { SystemParam } from '../../infra/database/entities/system-param.entity';
import { CACHE_KEY, CACHE_TTL } from '../../common/constants/enums';
import { RedisService } from '../../infra/redis/redis.module';
import { ParamService } from '../param/param.service';

/**
 * 字典与系统参数服务（F-14）。
 *
 * 参数读取/校验的**唯一实现**在 `ParamService`（分级缓存 + 主动失效 + 区间校验），
 * 本服务只保留「字典」职责，参数相关方法均为薄委托，供旧接口兼容使用。
 */
@Injectable()
export class DictService {
  private readonly logger = new Logger(DictService.name);

  constructor(
    @InjectRepository(DictItem) private readonly dictRepo: Repository<DictItem>,
    @InjectRepository(SystemParam) private readonly paramRepo: Repository<SystemParam>,
    private readonly redis: RedisService,
    private readonly paramService: ParamService,
  ) {}

  // ==========================================================================
  // 字典
  // ==========================================================================

  /** 按类型查询字典项（带缓存） */
  public async listByType(dictType: string, includeDisabled = false): Promise<DictItemDto[]> {
    const cacheKey = `${CACHE_KEY.DICT}${dictType}:${includeDisabled ? 'all' : 'active'}`;
    const cached = await this.redis.getJson<DictItemDto[]>(cacheKey);
    if (cached) return cached;

    const qb = this.dictRepo
      .createQueryBuilder('d')
      .where('d.dictType = :dictType', { dictType })
      .orderBy('d.sort', 'ASC')
      .addOrderBy('d.label', 'ASC');
    if (!includeDisabled) qb.andWhere('d.inUse = TRUE');
    const rows = await qb.getMany();
    const dtos = rows.map((r) => this.toDto(r));
    await this.redis.setJson(cacheKey, dtos, CACHE_TTL.DICT);
    return dtos;
  }

  /** 全部字典（前端一次性加载下拉选项） */
  public async listAll(): Promise<Record<string, DictItemDto[]>> {
    const rows = await this.dictRepo.find({ order: { dictType: 'ASC', sort: 'ASC' } });
    const grouped: Record<string, DictItemDto[]> = {};
    for (const r of rows) {
      if (!r.inUse) continue;
      if (!grouped[r.dictType]) grouped[r.dictType] = [];
      grouped[r.dictType].push(this.toDto(r));
    }
    return grouped;
  }

  /** 新增/更新字典项 */
  public async upsert(dto: UpsertDictItemDto): Promise<DictItemDto> {
    if (!dto.dictType || !dto.code || !dto.label) {
      throw new BizException(ErrorCode.BAD_REQUEST, '字典类型、编码、名称均不能为空');
    }
    if (dto.id) {
      const existing = await this.dictRepo.findOne({ where: { id: dto.id } });
      if (!existing) throw new BizException(ErrorCode.NOT_FOUND, '字典项不存在');
      await this.dictRepo.update(
        { id: dto.id },
        {
          label: dto.label,
          sort: dto.sort ?? existing.sort,
          inUse: dto.inUse ?? existing.inUse,
        },
      );
      await this.invalidate(dto.dictType);
      const updated = await this.dictRepo.findOne({ where: { id: dto.id } });
      return this.toDto(updated as DictItem);
    }

    const dup = await this.dictRepo.findOne({
      where: { dictType: dto.dictType, code: dto.code },
    });
    if (dup) {
      throw new BizException(ErrorCode.CONFLICT, `字典项「${dto.dictType}.${dto.code}」已存在`);
    }
    const saved = await this.dictRepo.save(
      this.dictRepo.create({
        dictType: dto.dictType,
        code: dto.code,
        label: dto.label,
        sort: dto.sort ?? 0,
        inUse: dto.inUse ?? true,
        builtin: false,
      }),
    );
    await this.invalidate(dto.dictType);
    return this.toDto(saved);
  }

  /** 删除字典项（内置或被引用时禁止） */
  public async remove(id: string): Promise<{ removed: boolean }> {
    const item = await this.dictRepo.findOne({ where: { id } });
    if (!item) throw new BizException(ErrorCode.NOT_FOUND, '字典项不存在');
    if (item.builtin) {
      throw new BizException(ErrorCode.DICT_IN_USE, '系统内置字典项不可删除，可停用');
    }
    if (item.inUse) {
      // 保守策略：在用项要求先停用（in_use=false）再删除，避免历史数据引用断裂
      throw new BizException(ErrorCode.DICT_IN_USE, '字典项正在使用，请先停用后再删除');
    }
    await this.dictRepo.delete({ id });
    await this.invalidate(item.dictType);
    return { removed: true };
  }

  // ==========================================================================
  // 系统参数（薄委托：唯一实现在 ParamService，此处仅为兼容旧接口保留）
  // ==========================================================================

  /**
   * 参数列表（敏感项脱敏）。
   *
   * @deprecated 管理端应改用 `GET /api/params`（带 PARAM_DEFS 元数据与区间校验）。
   * 本方法保留是为了不破坏既有前端调用，返回结构与旧版一致。
   */
  public async listParams(): Promise<SystemParamDto[]> {
    const rows = await this.paramRepo.find({ order: { key: 'ASC' } });
    return rows.map((r) => this.toParamDto(r));
  }

  /**
   * 保存参数。
   *
   * @deprecated 本方法**不带**区间校验与跨参数约束，仅为兼容旧前端保留。
   * 合规入口是 `PUT /api/params`（ParamService.upsert），它保证 PR-P4/P5/P7。
   * 这里做了最小加固：不可编辑参数仍然拒绝，避免绕过 PR-P7 固化项。
   */
  public async upsertParam(dto: UpsertParamDto): Promise<SystemParamDto> {
    const def = getParamDef(dto.key);
    if (def && !def.editable) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `${def.label} 为合规固化项（PR-P7），不允许修改，请通过 /api/params 接口操作`,
      );
    }
    if (def) {
      const check = validateParamValue(dto.key, dto.value);
      if (!check.ok) {
        throw new BizException(ErrorCode.BAD_REQUEST, check.reason ?? '参数取值非法');
      }
    }

    const existing = await this.paramRepo.findOne({ where: { key: dto.key } });
    if (existing) {
      await this.paramRepo.update(
        { key: dto.key },
        {
          value: dto.value,
          label: dto.label !== undefined ? dto.label : existing.label,
          secret: dto.secret !== undefined ? dto.secret : existing.secret,
        },
      );
      await this.paramService.invalidate([dto.key]);
      const updated = await this.paramRepo.findOne({ where: { key: dto.key } });
      return this.toParamDto(updated as SystemParam);
    }
    const saved = await this.paramRepo.save(
      this.paramRepo.create({
        key: dto.key,
        value: dto.value,
        label: dto.label ?? def?.label ?? null,
        secret: dto.secret ?? false,
        grp: def?.grp ?? 'misc',
        valueType: def?.type ?? 'string',
        editable: def?.editable ?? true,
      }),
    );
    await this.paramService.invalidate([dto.key]);
    return this.toParamDto(saved);
  }

  /** 预览水印开关（委托 ParamService：preview 组直读库，立即生效） */
  public async isWatermarkEnabled(): Promise<boolean> {
    return this.paramService.getBool('preview.watermark_enabled');
  }

  /** 下载模式（disabled / approval / free） */
  public async getDownloadMode(): Promise<'disabled' | 'approval' | 'free'> {
    const mode = await this.paramService.getEnum('preview.download_mode');
    return mode === 'free' ? 'free' : mode === 'approval' ? 'approval' : 'disabled';
  }

  /** 是否允许直接下载（free 才允许；approval 需走审批流） */
  public async isDownloadEnabled(): Promise<boolean> {
    return (await this.getDownloadMode()) === 'free';
  }

  /** 水印模板（预览渲染用） */
  public async getWatermarkTemplate(): Promise<string> {
    return this.paramService.get('preview.watermark_template');
  }

  private async invalidate(dictType: string): Promise<void> {
    await this.redis.delByPrefix(`${CACHE_KEY.DICT}${dictType}`);
  }

  private toDto(r: DictItem): DictItemDto {
    return {
      id: r.id,
      dictType: r.dictType,
      code: r.code,
      label: r.label,
      sort: r.sort,
      inUse: r.inUse,
      builtin: r.builtin,
    };
  }

  private toParamDto(r: SystemParam): SystemParamDto {
    return {
      id: r.id,
      key: r.key,
      value: r.secret ? '***' : r.value,
      label: r.label,
      secret: r.secret,
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }
}
