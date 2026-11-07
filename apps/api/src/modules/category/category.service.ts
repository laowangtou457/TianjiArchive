import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  type CategoryDto,
  type CreateCategoryDto,
  type MetadataFieldDef,
} from '@tianji/shared';
import { Category } from '../../infra/database/entities/category.entity';
import { CACHE_KEY, CACHE_TTL } from '../../common/constants/enums';
import { RedisService } from '../../infra/redis/redis.module';
import { buildCoreItemFields } from '../../infra/database/migrations/seed-data';

/**
 * 门类与动态著录字段集服务（F-12）。
 *
 * 合规底线（PRD §6）：核心著录字段（core=true）**不可裁剪**。
 * 保存 fieldSchema 时强制合并核心字段：即使前端删除了核心字段，
 * 服务端也会补齐，保证 DA/T 18/22 字段集完整。
 */
@Injectable()
export class CategoryService {
  private readonly logger = new Logger(CategoryService.name);

  constructor(
    @InjectRepository(Category) private readonly repo: Repository<Category>,
    private readonly redis: RedisService,
  ) {}

  /** 门类列表（带缓存） */
  public async list(includeInactive = false): Promise<CategoryDto[]> {
    const cacheKey = `${CACHE_KEY.CATEGORY}list:${includeInactive ? 'all' : 'active'}`;
    const cached = await this.redis.getJson<CategoryDto[]>(cacheKey);
    if (cached) return cached;

    const qb = this.repo.createQueryBuilder('c').orderBy('c.sort', 'ASC').addOrderBy('c.code', 'ASC');
    if (!includeInactive) qb.where('c.active = TRUE');
    const rows = await qb.getMany();
    const dtos = rows.map((r) => this.toDto(r));
    await this.redis.setJson(cacheKey, dtos, CACHE_TTL.CATEGORY);
    return dtos;
  }

  /** 门类详情（按 ID） */
  public async detail(id: string): Promise<CategoryDto> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '门类不存在');
    return this.toDto(row);
  }

  /** 按编码查找门类 */
  public async findByCode(code: string): Promise<Category | null> {
    return this.repo.findOne({ where: { code } });
  }

  /** 新增/更新门类（合并核心字段，保证不可裁剪） */
  public async upsert(dto: CreateCategoryDto & { id?: string }): Promise<CategoryDto> {
    const merged = this.mergeCoreFields(dto.fieldSchema ?? []);
    if (dto.id) {
      const row = await this.repo.findOne({ where: { id: dto.id } });
      if (!row) throw new BizException(ErrorCode.NOT_FOUND, '门类不存在');
      if (dto.code && dto.code !== row.code) {
        const dup = await this.repo.findOne({ where: { code: dto.code } });
        if (dup) throw new BizException(ErrorCode.CONFLICT, `门类编码「${dto.code}」已存在`);
      }
      await this.repo.update(
        { id: dto.id },
        {
          name: dto.name ?? row.name,
          code: dto.code ?? row.code,
          fieldSchema: merged,
          danghaoRuleId: dto.danghaoRuleId !== undefined ? dto.danghaoRuleId : row.danghaoRuleId,
          sort: dto.sort !== undefined ? dto.sort : row.sort,
          active: dto.active !== undefined ? dto.active : row.active,
        },
      );
      await this.invalidate();
      return this.detail(dto.id);
    }

    const dup = await this.repo.findOne({ where: { code: dto.code } });
    if (dup) throw new BizException(ErrorCode.CONFLICT, `门类编码「${dto.code}」已存在`);
    const saved = await this.repo.save(
      this.repo.create({
        code: dto.code,
        name: dto.name,
        fieldSchema: merged,
        danghaoRuleId: dto.danghaoRuleId ?? null,
        sort: dto.sort ?? 0,
        active: dto.active ?? true,
      }),
    );
    await this.invalidate();
    this.logger.log(`新建门类 ${saved.code} - ${saved.name}`);
    return this.toDto(saved);
  }

  /**
   * 获取某门类「件级」字段集（供前端动态表单渲染）。
   */
  public async itemFields(categoryId: string): Promise<MetadataFieldDef[]> {
    const cat = await this.detail(categoryId);
    return (cat.fieldSchema ?? [])
      .filter((f) => f.level === 'ITEM' || f.level === 'BOTH' || f.level === undefined)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** 获取某门类「卷级」字段集 */
  public async volumeFields(categoryId: string): Promise<MetadataFieldDef[]> {
    const cat = await this.detail(categoryId);
    return (cat.fieldSchema ?? [])
      .filter((f) => f.level === 'VOLUME' || f.level === 'BOTH' || f.level === undefined)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /**
   * 校验著录数据是否满足该门类的必填约束。
   * @returns 错误信息数组（空表示通过）
   */
  public validatePayload(
    fields: MetadataFieldDef[],
    payload: Record<string, unknown>,
    level: 'ITEM' | 'VOLUME',
  ): string[] {
    const errors: string[] = [];
    for (const f of fields) {
      const applies = f.level === level || f.level === 'BOTH' || f.level === undefined;
      if (!applies) continue;
      if (!f.required) continue;
      const value = payload[f.key];
      const empty =
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '') ||
        (Array.isArray(value) && value.length === 0);
      if (empty) {
        errors.push(`必填字段「${f.label}」不能为空`);
      }
      if (typeof value === 'string' && f.maxLength && value.length > f.maxLength) {
        errors.push(`字段「${f.label}」长度超过 ${f.maxLength}`);
      }
    }
    return errors;
  }

  /**
   * 合并核心字段：以标准核心字段集为基线，保留用户自定义字段与对非核心字段的调整，
   * 但核心字段的 required/type/key 由系统裁定（防止被裁剪或弱化）。
   */
  public mergeCoreFields(input: MetadataFieldDef[]): MetadataFieldDef[] {
    const core = buildCoreItemFields();
    const coreMap = new Map(core.map((f) => [f.key, f]));
    const result: MetadataFieldDef[] = [];

    for (const field of input) {
      if (!field || !field.key) continue;
      const coreDef = coreMap.get(field.key);
      if (coreDef) {
        // 核心字段：保留用户配置的 label/order/placeholder，但强制 required/type/core/readonly
        result.push({
          ...coreDef,
          label: field.label || coreDef.label,
          order: field.order ?? coreDef.order,
          placeholder: field.placeholder ?? coreDef.placeholder,
          helpText: field.helpText ?? coreDef.helpText,
          level: field.level ?? coreDef.level,
          options: coreDef.options ?? field.options,
        });
      } else {
        result.push({ ...field, core: false });
      }
    }

    // 补齐缺失的核心字段（不可裁剪）
    const present = new Set(result.map((f) => f.key));
    for (const c of core) {
      if (!present.has(c.key)) result.push(c);
    }

    return result.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  private async invalidate(): Promise<void> {
    await this.redis.delByPrefix(`${CACHE_KEY.CATEGORY}`);
  }

  private toDto(r: Category): CategoryDto {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      fieldSchema: Array.isArray(r.fieldSchema) ? r.fieldSchema : [],
      danghaoRuleId: r.danghaoRuleId,
      sort: r.sort,
      active: r.active,
      createdAt: new Date(r.createdAt).toISOString(),
    };
  }
}
