import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { PermissionSnapshot, WikiRelationDto, WikiSummaryDto, WikiTopicDto } from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { WikiService } from './wiki.service';

export class AddRelationBodyDto {
  @IsUUID() public targetItemId!: string;
  @IsOptional() @IsIn(['RELATED', 'SERIES', 'CITES', 'SAME_DOC']) public relationType?: string;
}

export class TopicQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() public limit?: number;
  @IsOptional() @IsString() @MaxLength(50) public keyword?: string;
}

/**
 * LLM Wiki 控制器（P4）：条目关联 / 主题聚合 / 条目摘要。
 *
 * 权限：SEARCH READ（与检索同门槛）；建关联需 SEARCH WRITE（编研人员的活）。
 * 所有出参都经过行级权限过滤 —— 无权档案的「存在性」也不外泄。
 */
@Controller('wiki')
export class WikiController {
  public constructor(private readonly wikiService: WikiService) {}

  @Get('items/:id/relations')
  @RequirePerm({
    domain: 'SEARCH',
    op: 'READ',
    checkScope: false,
    altPerm: { domain: 'KB', op: 'READ' },
    objectType: 'WIKI',
  })
  public async relations(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WikiRelationDto[]> {
    return this.wikiService.listRelations(id, user as PermissionSnapshot);
  }

  @Post('items/:id/relations')
  @RequirePerm({ domain: 'SEARCH', op: 'WRITE', checkScope: false, objectType: 'WIKI' })
  @Audit({ action: 'CREATE', objectType: 'WIKI_RELATION', objectIdPath: 'params.id' })
  public async addRelation(
    @Param('id') id: string,
    @Body() dto: AddRelationBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WikiRelationDto> {
    return this.wikiService.addRelation(
      id,
      dto.targetItemId,
      dto.relationType ?? 'RELATED',
      user as PermissionSnapshot,
    );
  }

  @Delete('relations/:id')
  @RequirePerm({ domain: 'SEARCH', op: 'WRITE', checkScope: false, objectType: 'WIKI' })
  @Audit({ action: 'DELETE', objectType: 'WIKI_RELATION', objectIdPath: 'params.id' })
  public async removeRelation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ deleted: boolean }> {
    return this.wikiService.removeRelation(id, user as PermissionSnapshot);
  }

  /** 自动关联（同主题词 + 同案卷） */
  @Post('items/:id/auto-link')
  @RequirePerm({ domain: 'SEARCH', op: 'WRITE', checkScope: false, objectType: 'WIKI' })
  @Audit({ action: 'UPDATE', objectType: 'WIKI_RELATION', objectIdPath: 'params.id' })
  public async autoLink(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ created: number }> {
    return this.wikiService.autoLink(id, user as PermissionSnapshot);
  }

  @Get('topics')
  @RequirePerm({
    domain: 'SEARCH',
    op: 'READ',
    checkScope: false,
    altPerm: { domain: 'KB', op: 'READ' },
    objectType: 'WIKI',
  })
  public async topics(
    @Query() q: TopicQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WikiTopicDto[]> {
    return this.wikiService.topics(q.limit ?? 30, user as PermissionSnapshot, q.keyword);
  }

  @Post('items/:id/summary')
  @RequirePerm({
    domain: 'SEARCH',
    op: 'READ',
    checkScope: false,
    altPerm: { domain: 'KB', op: 'READ' },
    objectType: 'WIKI',
  })
  public async summary(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WikiSummaryDto> {
    return this.wikiService.summary(id, user as PermissionSnapshot);
  }
}
