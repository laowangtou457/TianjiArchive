import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { CategoryDto, CreateCategoryDto, MetadataFieldDef } from '@tianji/shared';
import { CategoryService } from './category.service';
import { RequirePerm } from '../../common/decorators/require-perm.decorator';

class UpsertCategoryBodyDto implements CreateCategoryDto {
  @IsString()
  @IsNotEmpty({ message: '门类编码不能为空' })
  @MaxLength(32)
  public code!: string;

  @IsString()
  @IsNotEmpty({ message: '门类名称不能为空' })
  @MaxLength(100)
  public name!: string;

  @IsOptional()
  @IsArray()
  public fieldSchema?: MetadataFieldDef[];

  @IsOptional()
  @IsUUID()
  public danghaoRuleId?: string | null;

  @IsOptional()
  public sort?: number;

  @IsOptional()
  @IsBoolean()
  public active?: boolean;
}

/**
 * 门类/分类体系接口（F-12）。门类决定著录字段集与档号模板。
 */
@Controller('categories')
export class CategoryController {
  constructor(private readonly service: CategoryService) {}

  @Get()
  @RequirePerm({ domain: 'ITEM', op: 'READ', checkScope: false, objectType: 'CATEGORY' })
  public async list(@Query('includeInactive') includeInactive?: string): Promise<CategoryDto[]> {
    return this.service.list(includeInactive === 'true');
  }

  @Get(':id')
  public async detail(@Param('id') id: string): Promise<CategoryDto> {
    return this.service.detail(id);
  }

  /** 件级字段集（前端动态表单） */
  @Get(':id/fields/item')
  public async itemFields(@Param('id') id: string): Promise<MetadataFieldDef[]> {
    return this.service.itemFields(id);
  }

  /** 卷级字段集 */
  @Get(':id/fields/volume')
  public async volumeFields(@Param('id') id: string): Promise<MetadataFieldDef[]> {
    return this.service.volumeFields(id);
  }

  @Post()
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'WRITE', checkScope: false, objectType: 'CATEGORY' })
  public async create(@Body() dto: UpsertCategoryBodyDto): Promise<CategoryDto> {
    return this.service.upsert(dto);
  }

  @Patch(':id')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'WRITE', checkScope: false, objectType: 'CATEGORY' })
  public async update(
    @Param('id') id: string,
    @Body() dto: UpsertCategoryBodyDto,
  ): Promise<CategoryDto> {
    return this.service.upsert({ ...dto, id });
  }
}
