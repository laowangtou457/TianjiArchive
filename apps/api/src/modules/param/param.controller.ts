import { Body, Controller, Get, Header, Post, Put, Query } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import {
  PARAM_DEFS,
  type ParamConflict,
  type ParamDef,
  type ParamMetaDto,
} from '@tianji/shared';
import { RequirePerm, Audit, CurrentUser } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ParamService } from './param.service';

/** 单参数保存入参 */
export class UpsertParamItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  public key!: string;

  @IsString()
  @MaxLength(2000)
  public value!: string;
}

/** 批量保存入参 */
export class UpsertParamsBodyDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UpsertParamItemDto)
  public items!: UpsertParamItemDto[];
}

/** 单参数保存（带 key） */
export class UpsertOneParamBodyDto extends UpsertParamItemDto {}

/**
 * 业务参数管理接口（F-14 / PR-P1 ~ PR-P8）。
 *
 * 与 `/api/dicts/params`（旧接口，直接落库无校验）并存但职责不同：
 * 本控制器是**唯一合规入口**——带 PARAM_DEFS 派生元数据、区间校验、
 * 跨参数约束（C-1~C-5）与分级授权。
 */
@Controller('params')
export class ParamManageController {
  public constructor(private readonly paramService: ParamService) {}

  /**
   * 参数元数据（管理端渲染依据）。
   *
   * 返回 PARAM_DEFS 全量定义：key/默认值/区间/类型/grp/editable/说明。
   * 前端据此动态渲染控件、显示区间提示、禁用不可编辑项——
   * 避免前端另维护一份参数表导致漂移。
   */
  @Get('meta')
  public meta(): ParamDef[] {
    return PARAM_DEFS.map((d) => ({ ...d }));
  }

  /** 当前生效值（含来源，便于排查「改了不生效」） */
  @Get()
  @RequirePerm({ domain: 'PARAM', op: 'READ', checkScope: false, objectType: 'PARAM' })
  public async list(): Promise<ParamMetaDto[]> {
    const values = await this.paramService.getAll();
    return PARAM_DEFS.map((def) => ({
      key: def.key,
      value: values[def.key] ?? def.default,
      label: def.label,
      grp: def.grp,
      type: def.type,
      editable: def.editable,
      confirm: def.confirm,
      rangeText: def.rangeText,
      default: def.default,
      consumer: def.consumer,
      note: def.note ?? null,
    }));
  }

  /**
   * 预检跨参数约束（保存前调用，不落库）。
   *
   * 让管理员在提交前看到全部冲突（一次性返回），而不是保存失败一次报一条。
   */
  @Post('check')
  @RequirePerm({ domain: 'PARAM', op: 'READ', checkScope: false, objectType: 'PARAM' })
  public async check(@Body() dto: UpsertParamsBodyDto): Promise<ParamConflict[]> {
    return this.paramService.checkCross(dto.items);
  }

  /** 单参数保存 */
  @Put()
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'PARAM' })
  @Audit({ action: 'UPDATE', objectType: 'PARAM', mandatory: true, objectIdPath: 'body.key' })
  public async upsertOne(
    @Body() dto: UpsertOneParamBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ updated: true }> {
    await this.paramService.upsert(dto.key, dto.value, user.username);
    return { updated: true };
  }

  /** 批量保存（任一校验失败则整体不落库） */
  @Put('batch')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'PARAM' })
  @Audit({ action: 'UPDATE', objectType: 'PARAM', mandatory: true })
  public async upsertBatch(
    @Body() dto: UpsertParamsBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ updated: number }> {
    await this.paramService.upsertMany(dto.items, user.username);
    return { updated: dto.items.length };
  }
}

/**
 * 公开参数接口（无需 PARAM 权限）。
 *
 * 只暴露前端渲染必需的**非敏感运行期口径**，例如借阅规则说明文案。
 * 单独挂在 `/api/params` 之外的路径上，避免与权限管理面混淆。
 */
@Controller('public-params')
export class PublicParamController {
  public constructor(private readonly paramService: ParamService) {}

  /** 借阅规则（前端申请页预填与提示文案使用，与后端校验同源） */
  @Get('borrow-rules')
  @Header('Cache-Control', 'no-store')
  public async borrowRules(): Promise<{
    maxTotalDays: number;
    minDays: number;
    maxRenewalCount: number;
    maxRenewalDays: number;
    defaultDays: number;
  }> {
    return this.paramService.getBorrowRules();
  }

  /** 单个非敏感参数值（水印模板等展示用途） */
  @Get('value')
  public async value(@Query('key') key: string): Promise<{ key: string; value: string }> {
    const allowlist = new Set(['preview.watermark_template', 'preview.watermark_enabled']);
    // 白名单外一律拒绝：公开接口不能变成「参数读接口」，否则敏感参数会泄露
    if (!allowlist.has(key)) {
      return { key, value: '' };
    }
    return { key, value: await this.paramService.get(key) };
  }
}
