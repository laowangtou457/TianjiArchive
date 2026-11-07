import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsArray, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { KbQueryResponse, PermissionSnapshot } from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { KbService } from './kb.service';

/** 问答请求 DTO */
export class KbQueryBodyDto {
  @IsString()
  @MinLength(2, { message: '问题内容过短' })
  public question!: string;

  @IsOptional()
  public topK?: number;

  @IsOptional()
  @IsUUID()
  public fondsId?: string;
}

/** 重建索引 DTO */
export class ReindexBodyDto {
  @IsArray()
  @IsUUID('all', { each: true })
  public itemIds!: string[];
}

/**
 * 知识库控制器（F-20 P2 预留）。
 *
 * 路由已就位（`/api/kb/*`），P0 返回 501 + 明确提示，前端可提前接入。
 * 检索前强制复用 AccessFilterBuilder（密级 + 数据范围），与主检索同口径。
 */
@Controller('kb')
export class KbController {
  public constructor(private readonly kbService: KbService) {}

  /** 能力状态 */
  @Get('status')
  @RequirePerm({ domain: 'KB', op: 'READ', checkScope: false, objectType: 'KB' })
  public async status(@CurrentUser() user: AuthenticatedUser): Promise<{
    enabled: boolean;
    embeddingProvider: string;
    dimension: number;
    productionReady: boolean;
    indexedChunks: number;
    filter: Record<string, unknown>;
  }> {
    return this.kbService.status(user as PermissionSnapshot);
  }

  /** 问答（P0 未启用 → 501 KB_NOT_ENABLED） */
  @Post('query')
  @RequirePerm({ domain: 'KB', op: 'READ', checkScope: false, objectType: 'KB' })
  @Audit({ action: 'SEARCH', objectType: 'KB', mandatory: true, objectIdPath: 'body.fondsId' })
  public async query(
    @Body() dto: KbQueryBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<KbQueryResponse> {
    return this.kbService.query(dto, user as PermissionSnapshot);
  }

  /** 重建索引（P2 使用） */
  @Post('reindex')
  @RequirePerm({ domain: 'KB', op: 'WRITE', checkScope: false, objectType: 'KB' })
  @Audit({ action: 'UPDATE', objectType: 'KB', objectIdPath: 'body.itemIds' })
  public async reindex(@Body() dto: ReindexBodyDto): Promise<{ indexed: number }> {
    let total = 0;
    for (const id of dto.itemIds) {
      const r = await this.kbService.reindex(id);
      total += r.indexed;
    }
    return { indexed: total };
  }
}
