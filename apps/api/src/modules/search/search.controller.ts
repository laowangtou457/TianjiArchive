import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  type ConditionalSearchQuery,
  type FulltextSearchQuery,
  type FulltextSearchResult,
  type SavedSearchDto,
  type SearchHit,
  type SearchSynonymDto,
  type PermissionSnapshot,
  OpenFlag,
  ItemStatus,
  Retention,
  SecurityLevel,
} from '@tianji/shared';
import { SearchService } from './search.service';
import { SynonymService } from './synonym.service';
import { CurrentUser, RequirePerm, Audit } from '../../common/decorators/require-perm.decorator';
import { SavedSearch } from '../../infra/database/entities/saved-search.entity';

class SynonymBodyDto {
  @IsArray()
  @IsString({ each: true })
  public words!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public note?: string;
}

class SynonymPatchBodyDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public words?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public note?: string | null;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

class SaveSearchBodyDto {
  @IsString()
  @IsNotEmpty({ message: '名称不能为空' })
  @MaxLength(200)
  public name!: string;

  @IsOptional()
  public query?: Record<string, unknown>;

  @IsOptional()
  public shared?: boolean;
}

/**
 * 综合检索接口（F-05）。
 * 检索为敏感操作：强制留痕（SEARCH 不可关闭）。
 */
@Controller('search')
export class SearchController {
  constructor(
    private readonly service: SearchService,
    private readonly synonyms: SynonymService,
    @InjectRepository(SavedSearch) private readonly savedRepo: Repository<SavedSearch>,
  ) {}

  /** 关键字全文检索（ES + 高亮 + 分面） */
  @Get('fulltext')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'SEARCH' })
  @Audit({ action: 'SEARCH', objectType: 'SEARCH', mandatory: true })
  public async fulltext(
    @Query('q') q: string | undefined,
    @Query('fonds') fonds: string | string[] | undefined,
    @Query('yearFrom') yearFrom: string | undefined,
    @Query('yearTo') yearTo: string | undefined,
    @Query('level') level: SecurityLevel | SecurityLevel[] | undefined,
    @Query('retention') retention: Retention | Retention[] | undefined,
    @Query('category') category: string | string[] | undefined,
    @Query('status') status: ItemStatus | ItemStatus[] | undefined,
    @Query('openFlag') openFlag: OpenFlag | OpenFlag[] | undefined,
    @Query('sort') sort: FulltextSearchQuery['sort'] | undefined,
    @Query('page') page: string | undefined,
    @Query('size') size: string | undefined,
    @CurrentUser() user: PermissionSnapshot,
  ): Promise<FulltextSearchResult> {
    const query: FulltextSearchQuery = {
      q: (q ?? '').trim() || undefined,
      fonds: this.toArray(fonds),
      yearFrom: yearFrom ? Number.parseInt(yearFrom, 10) : undefined,
      yearTo: yearTo ? Number.parseInt(yearTo, 10) : undefined,
      level: this.toArray(level) as SecurityLevel[] | undefined,
      retention: this.toArray(retention) as Retention[] | undefined,
      category: this.toArray(category),
      status: this.toArray(status) as ItemStatus[] | undefined,
      openFlag: this.toArray(openFlag) as OpenFlag[] | undefined,
      sort: sort ?? 'relevance',
      page: page ? Number.parseInt(page, 10) : 1,
      size: size ? Number.parseInt(size, 10) : 20,
    };
    this.service.assertQueryValid(query);
    return this.service.fulltext(query, user);
  }

  /** 条件组合检索（PG，≥20 个可组合字段） */
  @Post('conditional')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'SEARCH' })
  @Audit({ action: 'SEARCH', objectType: 'SEARCH', mandatory: true })
  public async conditional(
    @Body() body: ConditionalSearchQuery,
    @CurrentUser() user: PermissionSnapshot,
  ): Promise<Awaited<ReturnType<SearchService['conditional']>>> {
    return this.service.conditional(body ?? {}, user);
  }

  /** 我的检索历史 */
  @Get('history')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'SEARCH' })
  public async history(
    @CurrentUser('userId') userId: string,
    @Query('limit') limit?: string,
  ): Promise<Array<{ keyword: string; createdAt: string }>> {
    return this.service.history(userId, limit ? Number.parseInt(limit, 10) : 20);
  }

  /** 保存的检索条件（含共享） */
  @Get('saved')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: false, objectType: 'SEARCH' })
  public async listSaved(@CurrentUser('userId') userId: string): Promise<SavedSearchDto[]> {
    const rows = await this.savedRepo
      .createQueryBuilder('s')
      .where('s.ownerId = :userId OR s.shared = TRUE', { userId })
      .orderBy('s.createdAt', 'DESC')
      .getMany();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      query: r.query,
      shared: r.shared,
      ownerId: r.ownerId,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  @Post('saved')
  @RequirePerm({ domain: 'SEARCH', op: 'WRITE', checkScope: false, objectType: 'SEARCH' })
  public async saveSearch(
    @Body() dto: SaveSearchBodyDto,
    @CurrentUser('userId') userId: string,
  ): Promise<SavedSearchDto> {
    const saved = await this.savedRepo.save(
      this.savedRepo.create({
        name: dto.name,
        query: dto.query ?? {},
        shared: dto.shared ?? false,
        ownerId: userId,
      }),
    );
    return {
      id: saved.id,
      name: saved.name,
      query: saved.query,
      shared: saved.shared,
      ownerId: saved.ownerId,
      createdAt: new Date(saved.createdAt).toISOString(),
    };
  }

  @Delete('saved/:id')
  @RequirePerm({ domain: 'SEARCH', op: 'DELETE', checkScope: false, objectType: 'SEARCH' })
  public async deleteSaved(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<{ deleted: boolean }> {
    const row = await this.savedRepo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, '保存的检索条件不存在');
    if (row.ownerId !== userId) {
      throw new BizException(ErrorCode.FORBIDDEN, '只能删除本人保存的检索条件');
    }
    await this.savedRepo.delete({ id });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ 同义词
  // 同义词是检索配置而非检索行为，权限挂 PARAM（系统参数），不给普通用户改。

  @Get('synonyms')
  @RequirePerm({ domain: 'PARAM', op: 'READ', checkScope: false, objectType: 'SEARCH' })
  public async listSynonyms(): Promise<SearchSynonymDto[]> {
    return this.synonyms.list();
  }

  @Post('synonyms')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'SEARCH' })
  @Audit({ action: 'UPDATE', objectType: 'SEARCH' })
  public async createSynonym(
    @Body() dto: SynonymBodyDto,
    @CurrentUser('userId') userId: string,
  ): Promise<SearchSynonymDto> {
    return this.synonyms.create(dto.words ?? [], dto.note ?? null, userId);
  }

  @Patch('synonyms/:id')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'SEARCH' })
  @Audit({ action: 'UPDATE', objectType: 'SEARCH' })
  public async updateSynonym(
    @Param('id') id: string,
    @Body() dto: SynonymPatchBodyDto,
  ): Promise<SearchSynonymDto> {
    return this.synonyms.update(id, {
      words: dto.words,
      note: dto.note,
      enabled: dto.enabled,
    });
  }

  @Delete('synonyms/:id')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'SEARCH' })
  @Audit({ action: 'DELETE', objectType: 'SEARCH' })
  public async deleteSynonym(@Param('id') id: string): Promise<{ deleted: boolean }> {
    return this.synonyms.remove(id);
  }

  /** 重建 ES 索引（R0/R1 运维操作） */
  @Post('reindex')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'SEARCH' })
  @Audit({ action: 'IMPORT', objectType: 'SEARCH' })
  public async reindex(): Promise<{ indexed: number }> {
    return this.service.reindexAll();
  }

  /** 单条结果详情（用于检索结果点开） */
  @Get('hits/:id')
  @RequirePerm({ domain: 'SEARCH', op: 'READ', checkScope: true, objectType: 'SEARCH' })
  public async hitDetail(
    @Param('id') id: string,
    @CurrentUser() user: PermissionSnapshot,
  ): Promise<SearchHit | null> {
    const result = await this.service.conditional(
      { filters: [{ field: 'id', operator: 'eq', value: id }], page: 1, size: 1 },
      user,
    );
    return result.list[0] ?? null;
  }

  /** 查询参数归一化：支持 `?a=1&a=2` 与 `?a=1,2` */
  private toArray(value: string | string[] | undefined): string[] | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value.flatMap((v) => String(v).split(',')).filter(Boolean);
    return String(value).split(',').filter(Boolean);
  }
}
