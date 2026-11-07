import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { DictItemDto, SystemParamDto } from '@tianji/shared';
import { DictService } from './dict.service';
import { RequirePerm } from '../../common/decorators/require-perm.decorator';

class UpsertDictBodyDto {
  @IsOptional()
  @IsUUID()
  public id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public dictType!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  public label!: string;

  @IsOptional()
  public sort?: number;

  @IsOptional()
  @IsBoolean()
  public inUse?: boolean;
}

class UpsertParamBodyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  public key!: string;

  @IsString()
  public value!: string;

  @IsOptional()
  @IsString()
  public label?: string;

  @IsOptional()
  @IsBoolean()
  public secret?: boolean;
}

/**
 * 数据字典接口（F-14）。
 * 读权限对所有登录用户开放（下拉选项），写权限限定 PARAM/DICT 域。
 */
@Controller('dicts')
export class DictController {
  constructor(private readonly service: DictService) {}

  /** 全部字典（前端启动时一次性拉取） */
  @Get()
  public async listAll(@Query('dictType') dictType?: string): Promise<Record<string, DictItemDto[]>> {
    if (dictType) {
      return { [dictType]: await this.service.listByType(dictType) };
    }
    return this.service.listAll();
  }

  @Get(':dictType')
  public async listByType(@Param('dictType') dictType: string): Promise<DictItemDto[]> {
    return this.service.listByType(dictType);
  }

  @Post()
  @RequirePerm({ domain: 'DICT', op: 'WRITE', checkScope: false, objectType: 'DICT' })
  public async upsert(@Body() dto: UpsertDictBodyDto): Promise<DictItemDto> {
    return this.service.upsert(dto);
  }

  @Delete(':id')
  @RequirePerm({ domain: 'DICT', op: 'DELETE', checkScope: false, objectType: 'DICT' })
  public async remove(@Param('id') id: string): Promise<{ removed: boolean }> {
    return this.service.remove(id);
  }
}

/** 系统参数接口（F-14） */
@Controller('params')
export class ParamController {
  constructor(private readonly service: DictService) {}

  @Get()
  public async list(): Promise<SystemParamDto[]> {
    return this.service.listParams();
  }

  @Put()
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'PARAM' })
  public async upsert(@Body() dto: UpsertParamBodyDto): Promise<SystemParamDto> {
    return this.service.upsertParam(dto);
  }
}
