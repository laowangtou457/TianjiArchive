import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import {
  Audit,
  CurrentUser,
  RequirePerm,
} from '../../common/decorators/require-perm.decorator';
import {
  ExtensionService,
  type CreateExtensionRecordDto,
  type ExtensionAction,
  type ExtensionActionDto,
  type ExtensionActionResult,
  type ExtensionListResult,
  type ExtensionRecordDto,
  type ExtensionRecordQuery,
  type UpdateExtensionRecordDto,
} from './extension.service';

// ---------------------------------------------------------------------------
// 请求体 DTO（文件内定义；category 决定真实功能域，Service 动态校验）
// ---------------------------------------------------------------------------

class CreateRecordBodyDto implements CreateExtensionRecordDto {
  @IsString()
  @MaxLength(64)
  public category!: string;

  @IsString()
  @MaxLength(200)
  public title!: string;

  @IsOptional()
  @IsObject()
  public bodyJson?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public status?: string;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

class UpdateRecordBodyDto implements UpdateExtensionRecordDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public title?: string;

  @IsOptional()
  @IsObject()
  public bodyJson?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public status?: string;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

const ACTIONS: readonly ExtensionAction[] = [
  'confirm',
  'reject',
  'publish',
  'unpublish',
  'execute',
  'check',
  'inbound',
  'outbound',
];

class ActionBodyDto implements ExtensionActionDto {
  @IsIn(ACTIONS)
  public action!: ExtensionAction;

  @IsOptional()
  @IsObject()
  public bodyJson?: Record<string, unknown>;
}

class ListQueryDto implements ExtensionRecordQuery {
  @IsOptional()
  @IsString()
  public category?: string;

  @IsOptional()
  @IsString()
  public status?: string;

  @IsOptional()
  @IsString()
  public keyword?: string;

  @IsOptional()
  public page?: number | string;

  @IsOptional()
  public size?: number | string;
}

/**
 * 扩展功能通用 CRUD / 状态流转接口。
 *
 * 所有端点都声明 @RequirePerm（PARAM 入口基线）+ @Audit（对应动作强制留痕）；
 * 记录真实的 category → 功能域映射（IMPORT_EXPORT / BACKUP / COMPILATION /
 * AUDIT_LOG / PARAM）由 Service 基于记录内容动态校验，避免通用端点成为越权旁路。
 */
@Controller('extension')
export class ExtensionController {
  constructor(private readonly service: ExtensionService) {}

  /** GET /extension/records?category=&status=&page=&size= → {list,total} */
  @Get('records')
  @RequirePerm({ domain: 'PARAM', op: 'READ', checkScope: false, objectType: 'EXTENSION_RECORD' })
  @Audit({ action: 'SEARCH', objectType: 'EXTENSION_RECORD' })
  public async list(
    @Query() query: ListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExtensionListResult> {
    return this.service.list(query, user);
  }

  /** POST /extension/records */
  @Post('records')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'EXTENSION_RECORD' })
  @Audit({ action: 'CREATE', objectType: 'EXTENSION_RECORD' })
  public async create(
    @Body() dto: CreateRecordBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExtensionRecordDto> {
    return this.service.create(dto, user);
  }

  /** PATCH /extension/records/:id */
  @Patch('records/:id')
  @RequirePerm({ domain: 'PARAM', op: 'WRITE', checkScope: false, objectType: 'EXTENSION_RECORD' })
  @Audit({ action: 'UPDATE', objectType: 'EXTENSION_RECORD', objectIdPath: 'params.id' })
  public async update(
    @Param('id') id: string,
    @Body() dto: UpdateRecordBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExtensionRecordDto> {
    return this.service.update(id, dto, user);
  }

  /** DELETE /extension/records/:id */
  @Delete('records/:id')
  @RequirePerm({ domain: 'PARAM', op: 'DELETE', checkScope: false, objectType: 'EXTENSION_RECORD' })
  @Audit({ action: 'DELETE', objectType: 'EXTENSION_RECORD', objectIdPath: 'params.id', mandatory: true })
  public async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ deleted: boolean }> {
    return this.service.remove(id, user);
  }

  /** POST /extension/records/:id/action —— 状态流转 + 业务回调 */
  @Post('records/:id/action')
  @RequirePerm({ domain: 'PARAM', op: 'APPROVE', checkScope: false, objectType: 'EXTENSION_RECORD' })
  @Audit({ action: 'APPROVE', objectType: 'EXTENSION_RECORD', objectIdPath: 'params.id', mandatory: true })
  public async action(
    @Param('id') id: string,
    @Body() dto: ActionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExtensionActionResult> {
    return this.service.action(id, dto, user);
  }
}
