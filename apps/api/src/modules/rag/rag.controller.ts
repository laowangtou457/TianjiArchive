import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type {
  PermissionSnapshot,
  RagAskResult,
  RagReindexResult,
  RagRetrieveResult,
  RagStatusDto,
} from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { RagService } from './rag.service';

export class RagRetrieveBodyDto {
  @IsString() @MinLength(1) @MaxLength(500) public query!: string;
  @IsOptional() @Type(() => Number) @IsInt() public topK?: number;
}

export class RagAskBodyDto {
  @IsString() @MinLength(2) @MaxLength(500) public question!: string;
  @IsOptional() @Type(() => Number) @IsInt() public topK?: number;
}

export class RagReindexBodyDto {
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) public ids?: string[];
  @IsOptional() @Type(() => Number) @IsInt() public limit?: number;
  /** 强制重建（含已有块的条目） */
  @IsOptional() public force?: boolean;
}

/**
 * RAG 检索/问答接口（P4）。
 *
 * 权限：检索域（SEARCH READ），与综合检索同门槛 —— 能检索就能用 RAG；
 * 具体能看到哪些片段仍由 AccessFilterBuilder 在 SQL 层裁决（R3 看不到秘密件）。
 * 建库接口要求 PARAM 写权限（系统管理员的活，会影响全库索引）。
 */
@Controller('rag')
export class RagController {
  public constructor(private readonly ragService: RagService) {}

  @Get('status')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'RAG' })
  public async status(): Promise<RagStatusDto> {
    return this.ragService.status();
  }

  @Post('retrieve')
  @RequirePerm({
    domain: 'SEARCH',
    op: 'READ',
    checkScope: false,
    altPerm: { domain: 'KB', op: 'READ' },
    objectType: 'RAG',
  })
  public async retrieve(
    @Body() dto: RagRetrieveBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RagRetrieveResult> {
    return this.ragService.retrieve(dto.query, user as PermissionSnapshot, dto.topK);
  }

  @Post('ask')
  @RequirePerm({
    domain: 'SEARCH',
    op: 'READ',
    checkScope: false,
    altPerm: { domain: 'KB', op: 'READ' },
    objectType: 'RAG',
  })
  @Audit({ action: 'SEARCH', objectType: 'RAG', mandatory: true })
  public async ask(
    @Body() dto: RagAskBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RagAskResult> {
    return this.ragService.ask(dto.question, user as PermissionSnapshot, dto.topK);
  }

  @Post('reindex')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'RAG' })
  @Audit({ action: 'IMPORT', objectType: 'RAG', mandatory: true })
  public async reindex(
    @Body() dto: RagReindexBodyDto,
    @Query('limit') limit?: string,
  ): Promise<RagReindexResult> {
    return this.ragService.reindex({
      ids: dto.ids,
      limit: dto.limit ?? (limit ? Number(limit) : undefined),
      force: dto.force === true,
    });
  }
}
