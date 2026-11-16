import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import type { PermissionSnapshot } from '@tianji/shared';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { WikiPagesService } from './wiki-pages.service';

export class CreateSpaceBodyDto {
  @IsString() @MaxLength(100) public name!: string;
  @IsOptional() @IsString() @MaxLength(500) public description?: string;
  @IsOptional() @IsIn(['PUBLIC', 'INTERNAL', 'SECRET']) public securityLevel?: string;
}

export class UpdateSpaceBodyDto {
  @IsOptional() @IsString() @MaxLength(100) public name?: string;
  @IsOptional() @IsString() @MaxLength(500) public description?: string;
  @IsOptional() @IsIn(['PUBLIC', 'INTERNAL', 'SECRET']) public securityLevel?: string;
}

export class CreatePageBodyDto {
  @IsUUID() public spaceId!: string;
  @IsOptional() @IsUUID() public parentId?: string | null;
  @IsString() @MaxLength(200) public title!: string;
  @IsOptional() @IsString() @MaxLength(500_000) public contentMd?: string;
  @IsOptional() @Type(() => Number) @IsInt() public orderNo?: number;
}

export class UpdatePageBodyDto {
  @IsOptional() @IsString() @MaxLength(200) public title?: string;
  @IsOptional() @IsString() @MaxLength(500_000) public contentMd?: string;
  /** null 表示移到顶层；undefined 表示不动 */
  @IsOptional() @IsUUID() public parentId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() public orderNo?: number;
}

export class RestoreVersionBodyDto {
  @Type(() => Number) @IsInt() @Min(1) public versionNo!: number;
}

export class WikiAskBodyDto {
  @IsString() @MaxLength(500) public question!: string;
  @IsOptional() @IsUUID() public spaceId?: string;
}

/**
 * 可编辑 Wiki 页面库（知识 Wiki）控制器。
 *
 * 权限：WIKI READ = 浏览/问答；WIKI WRITE = 维护空间与页面（编研人员）。
 * 读接口带 altPerm KB/SEARCH READ 不放开 —— Wiki 是编研知识，与档案检索
 * 权限域分离，避免「能查档案就能改知识库」的越权误解（读也不放：Wiki 页面
 * 可能引用未开放档案的结论）。
 */
@Controller('wiki')
export class WikiPagesController {
  public constructor(private readonly service: WikiPagesService) {}

  // ---- 空间 ----

  @Get('spaces')
  @RequirePerm({ domain: 'WIKI', op: 'READ', checkScope: false, objectType: 'WIKI_SPACE' })
  public async listSpaces(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listSpaces(user as PermissionSnapshot);
  }

  @Post('spaces')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_SPACE' })
  @Audit({ action: 'CREATE', objectType: 'WIKI_SPACE', objectIdPath: 'body.name' })
  public async createSpace(@Body() dto: CreateSpaceBodyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.createSpace(dto, user as PermissionSnapshot);
  }

  @Put('spaces/:id')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_SPACE' })
  @Audit({ action: 'UPDATE', objectType: 'WIKI_SPACE', objectIdPath: 'params.id' })
  public async updateSpace(
    @Param('id') id: string,
    @Body() dto: UpdateSpaceBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.updateSpace(id, dto, user as PermissionSnapshot);
  }

  @Delete('spaces/:id')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_SPACE' })
  @Audit({ action: 'DELETE', objectType: 'WIKI_SPACE', objectIdPath: 'params.id' })
  public async deleteSpace(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.deleteSpace(id, user as PermissionSnapshot);
  }

  // ---- 页面 ----

  @Get('spaces/:id/tree')
  @RequirePerm({ domain: 'WIKI', op: 'READ', checkScope: false, objectType: 'WIKI_SPACE' })
  public async pageTree(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.pageTree(id, user as PermissionSnapshot);
  }

  @Post('pages')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_PAGE' })
  @Audit({ action: 'CREATE', objectType: 'WIKI_PAGE', objectIdPath: 'body.title' })
  public async createPage(@Body() dto: CreatePageBodyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.createPage(dto, user as PermissionSnapshot);
  }

  /** 静态路径必须在 pages/:id 之前声明，否则被 :id 匹配吞掉 */
  @Get('pages/index-status')
  @RequirePerm({ domain: 'WIKI', op: 'READ', checkScope: false, objectType: 'WIKI_PAGE' })
  public async indexStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.service.indexStatus(user as PermissionSnapshot);
  }

  @Get('pages/:id')
  @RequirePerm({ domain: 'WIKI', op: 'READ', checkScope: false, objectType: 'WIKI_PAGE' })
  public async getPage(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getPage(id, user as PermissionSnapshot);
  }

  @Put('pages/:id')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_PAGE' })
  @Audit({ action: 'UPDATE', objectType: 'WIKI_PAGE', objectIdPath: 'params.id' })
  public async updatePage(
    @Param('id') id: string,
    @Body() dto: UpdatePageBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.updatePage(id, dto, user as PermissionSnapshot);
  }

  @Delete('pages/:id')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_PAGE' })
  @Audit({ action: 'DELETE', objectType: 'WIKI_PAGE', objectIdPath: 'params.id' })
  public async deletePage(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.deletePage(id, user as PermissionSnapshot);
  }

  @Get('pages/:id/versions')
  @RequirePerm({ domain: 'WIKI', op: 'READ', checkScope: false, objectType: 'WIKI_PAGE' })
  public async listVersions(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listVersions(id, user as PermissionSnapshot);
  }

  @Post('pages/:id/restore')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_PAGE' })
  @Audit({ action: 'UPDATE', objectType: 'WIKI_PAGE_VERSION', objectIdPath: 'params.id' })
  public async restoreVersion(
    @Param('id') id: string,
    @Body() dto: RestoreVersionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.restoreVersion(id, dto.versionNo, user as PermissionSnapshot);
  }

  // ---- 问答 / 向量库 ----

  @Post('pages/ask')
  @RequirePerm({ domain: 'WIKI', op: 'READ', checkScope: false, objectType: 'WIKI_PAGE' })
  @Audit({ action: 'CREATE', objectType: 'WIKI_ASK', objectIdPath: 'body.question', mandatory: true })
  public async ask(@Body() dto: WikiAskBodyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.ask(dto.question, user as PermissionSnapshot, dto.spaceId);
  }

  @Post('pages/reindex')
  @RequirePerm({ domain: 'WIKI', op: 'WRITE', checkScope: false, objectType: 'WIKI_PAGE' })
  @Audit({ action: 'UPDATE', objectType: 'WIKI_INDEX' })
  public async reindex(@CurrentUser() user: AuthenticatedUser) {
    return this.service.reindex(user as PermissionSnapshot);
  }
}
