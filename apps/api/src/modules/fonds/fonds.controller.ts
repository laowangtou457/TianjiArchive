import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  FondsStatus,
  type CreateFondsDto,
  type CreateOrgNodeDto,
  type FondsDto,
  type OrgNodeDto,
  type PageResult,
} from '@tianji/shared';
import { FondsService } from './fonds.service';
import { CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';

class CreateFondsBodyDto implements CreateFondsDto {
  @IsString()
  @IsNotEmpty({ message: '全宗号不能为空' })
  @MaxLength(32)
  public fondsNo!: string;

  @IsString()
  @IsNotEmpty({ message: '全宗名称不能为空' })
  @MaxLength(200)
  public name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public orgName?: string | null;

  @IsOptional()
  @IsInt()
  public yearStart?: number | null;

  @IsOptional()
  @IsInt()
  public yearEnd?: number | null;

  @IsOptional()
  @IsEnum(FondsStatus)
  public status?: FondsStatus;

  @IsOptional()
  @IsString()
  public historyNote?: string | null;
}

class UpdateFondsBodyDto extends CreateFondsBodyDto {
  @IsOptional()
  @IsString()
  declare public fondsNo: string;
}

class CreateOrgBodyDto implements CreateOrgNodeDto {
  @IsUUID()
  public fondsId!: string;

  @IsOptional()
  @IsUUID()
  public parentId?: string | null;

  @IsString()
  @IsNotEmpty({ message: '机构代码不能为空' })
  @MaxLength(64)
  public code!: string;

  @IsString()
  @IsNotEmpty({ message: '机构名称不能为空' })
  @MaxLength(200)
  public name!: string;
}

/**
 * 全宗与机构树接口（F-01）。
 */
@Controller('fonds')
export class FondsController {
  constructor(private readonly service: FondsService) {}

  @Get()
  @RequirePerm({ domain: 'FONDS', op: 'READ', checkScope: false, objectType: 'FONDS' })
  public async list(
    @Query('page') page: string | undefined,
    @Query('size') size: string | undefined,
    @Query('keyword') keyword: string | undefined,
    @Query('status') status: FondsStatus | undefined,
    @CurrentUser('fondsIds') fondsIds: string[] | null,
  ): Promise<PageResult<FondsDto>> {
    return this.service.list({
      page: Number.parseInt(page ?? '1', 10) || 1,
      size: Number.parseInt(size ?? '20', 10) || 20,
      keyword,
      status,
      allowedFondsIds: fondsIds,
    });
  }

  @Get(':id')
  @RequirePerm({ domain: 'FONDS', op: 'READ', checkScope: true, objectType: 'FONDS' })
  public async detail(@Param('id') id: string): Promise<FondsDto> {
    return this.service.detail(id);
  }

  @Post()
  @RequirePerm({ domain: 'FONDS', op: 'WRITE', checkScope: false, objectType: 'FONDS' })
  public async create(@Body() dto: CreateFondsBodyDto): Promise<FondsDto> {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePerm({ domain: 'FONDS', op: 'WRITE', checkScope: true, objectType: 'FONDS' })
  public async update(
    @Param('id') id: string,
    @Body() dto: UpdateFondsBodyDto,
  ): Promise<FondsDto> {
    return this.service.update({ ...dto, id });
  }

  /** 全宗下的机构树 */
  @Get(':id/orgs')
  @RequirePerm({ domain: 'FONDS', op: 'READ', checkScope: true, objectType: 'ORG' })
  public async orgTree(@Param('id') id: string): Promise<OrgNodeDto[]> {
    return this.service.orgTree(id);
  }

  /** 新增机构节点 */
  @Post(':id/orgs')
  @RequirePerm({ domain: 'FONDS', op: 'WRITE', checkScope: true, objectType: 'ORG' })
  public async createOrg(
    @Param('id') fondsId: string,
    @Body() dto: CreateOrgBodyDto,
  ): Promise<OrgNodeDto> {
    return this.service.createOrg({ ...dto, fondsId });
  }
}
