import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  type DanghaoRuleDto,
  type DanghaoSegment,
  type PreviewDanghaoResponse,
  ResetCycle,
} from '@tianji/shared';
import { DanghaoRuleService } from './rule.service';
import { DanghaoSequenceService } from './sequence.service';
import { RequirePerm } from '../../common/decorators/require-perm.decorator';

class SegmentDto implements DanghaoSegment {
  @IsEnum(['FONDS', 'CATALOG', 'YEAR', 'ORG', 'RETENTION', 'VOLUME', 'ITEM'])
  public type!: DanghaoSegment['type'];

  @IsOptional()
  @IsInt()
  @Min(0)
  public pad?: number;

  @IsOptional()
  @IsString()
  public literal?: string;

  @IsOptional()
  @IsString()
  public fixed?: string;
}

class CreateRuleBodyDto {
  @IsUUID()
  public fondsId!: string;

  @IsOptional()
  @IsUUID()
  public categoryId?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  public segments!: SegmentDto[];

  @IsOptional()
  @IsString()
  @MaxLength(4)
  public separator?: string;

  @IsOptional()
  @IsEnum(ResetCycle)
  public resetCycle?: ResetCycle;

  @IsOptional()
  @IsInt()
  @Min(0)
  public zeroPad?: number;

  @IsOptional()
  @IsBoolean()
  public active?: boolean;
}

class UpdateRuleBodyDto extends CreateRuleBodyDto {
  @IsOptional()
  @IsUUID()
  declare public fondsId: string;

  @IsOptional()
  @IsArray()
  declare public segments: SegmentDto[];
}

class PreviewBodyDto {
  @IsUUID()
  public fondsId!: string;

  @IsOptional()
  @IsUUID()
  public categoryId?: string | null;

  @IsInt()
  public year!: number;

  @IsOptional()
  @IsString()
  public orgCode?: string;

  @IsOptional()
  @IsString()
  public retentionCode?: string;

  @IsOptional()
  @IsString()
  public catalogNo?: string;

  @IsOptional()
  @IsInt()
  public volumeNo?: number;

  @IsOptional()
  @IsInt()
  public itemNo?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  public count?: number;
}

/**
 * 档号规则接口（F-02）。规则配置与试算。
 */
@Controller('danghao-rules')
export class DanghaoRuleController {
  constructor(
    private readonly ruleService: DanghaoRuleService,
    private readonly sequenceService: DanghaoSequenceService,
  ) {}

  @Get()
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'READ', checkScope: false, objectType: 'DANGHAO_RULE' })
  public async list(@Query('fondsId') fondsId?: string): Promise<DanghaoRuleDto[]> {
    return this.ruleService.list(fondsId);
  }

  @Get(':id')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'READ', checkScope: false, objectType: 'DANGHAO_RULE' })
  public async detail(@Param('id') id: string): Promise<DanghaoRuleDto> {
    return this.ruleService.detail(id);
  }

  @Post()
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'WRITE', checkScope: false, objectType: 'DANGHAO_RULE' })
  public async create(@Body() dto: CreateRuleBodyDto): Promise<DanghaoRuleDto> {
    return this.ruleService.create(dto);
  }

  @Patch(':id')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'WRITE', checkScope: false, objectType: 'DANGHAO_RULE' })
  public async update(
    @Param('id') id: string,
    @Body() dto: UpdateRuleBodyDto,
  ): Promise<DanghaoRuleDto> {
    return this.ruleService.update({ ...dto, id });
  }

  /**
   * 规则试算：按规则 + 上下文生成示例档号（不消耗真实序列）。
   * 试算与真实生成同源（packages/shared/danghao），保证「试算 = 生成」。
   */
  @Post(':id/preview')
  @RequirePerm({
    domain: 'DANGHAO_RULE',
    op: 'READ',
    checkScope: false,
    objectType: 'DANGHAO_RULE',
  })
  public async preview(
    @Param('id') ruleId: string,
    @Body() dto: PreviewBodyDto,
  ): Promise<PreviewDanghaoResponse> {
    return this.ruleService.preview(dto, ruleId);
  }

  /** 未指定规则时按全宗+门类自动匹配后试算 */
  @Post('preview')
  @RequirePerm({
    domain: 'DANGHAO_RULE',
    op: 'READ',
    checkScope: false,
    objectType: 'DANGHAO_RULE',
  })
  public async previewAuto(@Body() dto: PreviewBodyDto): Promise<PreviewDanghaoResponse> {
    return this.ruleService.preview(dto);
  }

  /** 查看某作用域的下一个流水号（排障用） */
  @Get('sequences/:scopeKey')
  @RequirePerm({ domain: 'DANGHAO_RULE', op: 'READ', checkScope: false, objectType: 'DANGHAO_RULE' })
  public async peek(@Param('scopeKey') scopeKey: string): Promise<{ scopeKey: string; nextValue: number }> {
    return { scopeKey, nextValue: await this.sequenceService.peek(scopeKey) };
  }
}
