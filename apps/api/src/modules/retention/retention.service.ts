import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BizException, ErrorCode } from '@tianji/shared';
import { RetentionPlan } from '../../infra/database/entities/retention-plan.entity';

/** 保管期限表 DTO */
export interface RetentionPlanDto {
  id: string;
  code: string;
  name: string;
  years: number;
  level: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 新增/编辑入参 */
export interface UpsertRetentionPlanInput {
  code: string;
  name: string;
  years: number;
  level?: string;
  description?: string | null;
  enabled?: boolean;
}

/**
 * 保管期限表服务 P5（DANGHAO_RULE 域）。
 * code 唯一；删除为硬删除，编辑时校验编码冲突。
 */
@Injectable()
export class RetentionService {
  constructor(
    @InjectRepository(RetentionPlan)
    private readonly planRepo: Repository<RetentionPlan>,
  ) {}

  /** 全部期限方案（含停用项，由前端控制展示） */
  public async listPlans(): Promise<RetentionPlanDto[]> {
    const rows = await this.planRepo.find({ order: { years: 'DESC', code: 'ASC' } });
    return rows.map((r) => this.toDto(r));
  }

  /** 新增 */
  public async create(input: UpsertRetentionPlanInput): Promise<RetentionPlanDto> {
    const code = (input.code ?? '').trim();
    const name = (input.name ?? '').trim();
    if (!code || !name) {
      throw new BizException(ErrorCode.BAD_REQUEST, '期限代码与名称均不能为空');
    }
    if (!Number.isInteger(input.years)) {
      throw new BizException(ErrorCode.BAD_REQUEST, '年限必须为整数（永久可填 -1）');
    }
    await this.assertCodeFree(code);
    const saved = await this.planRepo.save(
      this.planRepo.create({
        code,
        name,
        years: input.years,
        level: (input.level ?? 'Y30').trim() || 'Y30',
        description: input.description ?? null,
        enabled: input.enabled ?? true,
      }),
    );
    return this.toDto(saved);
  }

  /** 编辑 */
  public async update(id: string, input: Partial<UpsertRetentionPlanInput>): Promise<RetentionPlanDto> {
    const row = await this.planRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '保管期限方案不存在');
    if (input.code !== undefined) {
      const code = input.code.trim();
      if (!code) throw new BizException(ErrorCode.BAD_REQUEST, '期限代码不能为空');
      if (code !== row.code) await this.assertCodeFree(code, id);
      row.code = code;
    }
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BizException(ErrorCode.BAD_REQUEST, '期限名称不能为空');
      row.name = name;
    }
    if (input.years !== undefined) {
      if (!Number.isInteger(input.years)) {
        throw new BizException(ErrorCode.BAD_REQUEST, '年限必须为整数（永久可填 -1）');
      }
      row.years = input.years;
    }
    if (input.level !== undefined) row.level = input.level.trim() || 'Y30';
    if (input.description !== undefined) row.description = input.description;
    if (input.enabled !== undefined) row.enabled = input.enabled;

    const saved = await this.planRepo.save(row);
    return this.toDto(saved);
  }

  /** 删除 */
  public async remove(id: string): Promise<{ removed: boolean }> {
    const row = await this.planRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '保管期限方案不存在');
    await this.planRepo.delete({ id });
    return { removed: true };
  }

  private async assertCodeFree(code: string, exceptId?: string): Promise<void> {
    const dup = await this.planRepo.findOne({ where: { code } });
    if (dup && dup.id !== exceptId) {
      throw new BizException(ErrorCode.CONFLICT, `保管期限代码「${code}」已存在`);
    }
  }

  private toDto(r: RetentionPlan): RetentionPlanDto {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      years: r.years,
      level: r.level,
      description: r.description,
      enabled: r.enabled,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }
}
