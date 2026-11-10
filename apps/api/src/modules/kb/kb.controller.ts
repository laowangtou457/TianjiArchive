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

/** 重建索引 DTO（itemIds 为空表示自动挑选陈旧/未索引条目） */
export class ReindexBodyDto {
  @IsArray()
  @IsUUID('all', { each: true })
  public itemIds!: string[];
}

/**
 * 知识库控制器（F-22 片段检索，A 档）。
 *
 * 路由保持 `/api/kb/*` 不变，前端无需改契约。
 * 检索前强制复用 AccessFilterBuilder（密级 + 数据范围），与主检索同口径。
 *
 * 注意：本控制器**不生成答案**，只返回依据片段；生成式问答属 B 档，
 * 需本地模型与硬件复核（《RAG知识库立项书》§4）。
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
    retriever: string;
    mode: 'lexical' | 'vector';
    searchReady: boolean;
    filter: Record<string, unknown>;
  }> {
    return this.kbService.status(user as PermissionSnapshot);
  }

  /** 片段检索（返回依据片段，不生成答案） */
  @Post('query')
  @RequirePerm({ domain: 'KB', op: 'READ', checkScope: false, objectType: 'KB' })
  @Audit({ action: 'SEARCH', objectType: 'KB', mandatory: true, objectIdPath: 'body.fondsId' })
  public async query(
    @Body() dto: KbQueryBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<KbQueryResponse> {
    return this.kbService.query(dto, user as PermissionSnapshot);
  }

  /** 重建片段索引（itemIds 为空 → 自动挑选陈旧/未索引条目） */
  @Post('reindex')
  @RequirePerm({ domain: 'KB', op: 'WRITE', checkScope: false, objectType: 'KB' })
  @Audit({ action: 'UPDATE', objectType: 'KB', objectIdPath: 'body.itemIds' })
  public async reindex(
    @Body() dto: ReindexBodyDto,
  ): Promise<{ indexed: number; items: number; failed: number }> {
    return this.kbService.reindex(dto.itemIds ?? []);
  }
}
