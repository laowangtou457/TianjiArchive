import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SecurityLevel,
  UserStatus,
  type PageResult,
  type RoleDto,
  type UserDto,
} from '@tianji/shared';
import { UserAdminService } from './user-admin.service';
import { Audit, CurrentUser, RequirePerm } from '../../common/decorators/require-perm.decorator';
import { AUDIT_OBJECT } from '../../common/constants/enums';

class ScopeItemDto {
  @IsEnum(['ALL', 'FONDS', 'ORG', 'SELF'])
  public scopeType!: 'ALL' | 'FONDS' | 'ORG' | 'SELF';

  @IsOptional()
  @IsUUID()
  public scopeRefId?: string | null;
}

class CreateUserBodyDto {
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  @MaxLength(64)
  public username!: string;

  @IsString()
  @MinLength(8, { message: '密码长度不得少于 8 位' })
  public password!: string;

  @IsString()
  @IsNotEmpty({ message: '姓名不能为空' })
  @MaxLength(64)
  public displayName!: string;

  @IsOptional()
  @IsEnum(UserStatus)
  public status?: UserStatus;

  @IsOptional()
  @IsEnum(SecurityLevel)
  public maxSecurityLevel?: SecurityLevel;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  public roleIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeItemDto)
  public scopes?: ScopeItemDto[];
}

class UpdateUserBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public displayName?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  public status?: UserStatus;

  @IsOptional()
  @IsEnum(SecurityLevel)
  public maxSecurityLevel?: SecurityLevel;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  public roleIds?: string[];

  @IsOptional()
  @IsString()
  @MinLength(8)
  public password?: string;
}

class PermissionGrantDto {
  @IsString()
  public domain!: string;

  @IsArray()
  @IsString({ each: true })
  public ops!: string[];

  @IsString()
  public mode!: string;

  @IsOptional()
  public scoped?: boolean;

  @IsOptional()
  public levelCapped?: boolean;
}

class UpdateRolePermissionsBodyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionGrantDto)
  public permissions!: PermissionGrantDto[];
}

class UpdateUserScopesBodyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeItemDto)
  public scopes!: ScopeItemDto[];
}

/**
 * 用户与权限接口（F-09）。
 * 权限：R0 系统管理员专属（USER 域）。
 */
@Controller('users')
export class UserController {
  constructor(private readonly admin: UserAdminService) {}

  @Get()
  @RequirePerm({ domain: 'USER', op: 'READ', checkScope: false, objectType: AUDIT_OBJECT.USER })
  public async list(
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: UserStatus,
  ): Promise<PageResult<UserDto>> {
    return this.admin.list({
      page: Number.parseInt(page ?? '1', 10) || 1,
      size: Number.parseInt(size ?? '20', 10) || 20,
      keyword,
      status,
    });
  }

  @Get(':id')
  @RequirePerm({ domain: 'USER', op: 'READ', checkScope: false, objectType: AUDIT_OBJECT.USER })
  public async detail(@Param('id') id: string): Promise<UserDto> {
    return this.admin.detail(id);
  }

  @Post()
  @RequirePerm({ domain: 'USER', op: 'WRITE', checkScope: false, objectType: AUDIT_OBJECT.USER })
  @Audit({ action: 'PERM_CHANGE', objectType: AUDIT_OBJECT.USER, mandatory: true })
  public async create(@Body() dto: CreateUserBodyDto): Promise<UserDto> {
    return this.admin.create(dto);
  }

  @Patch(':id')
  @RequirePerm({ domain: 'USER', op: 'WRITE', checkScope: false, objectType: AUDIT_OBJECT.USER })
  @Audit({ action: 'PERM_CHANGE', objectType: AUDIT_OBJECT.USER, mandatory: true })
  public async update(@Param('id') id: string, @Body() dto: UpdateUserBodyDto): Promise<UserDto> {
    return this.admin.update({ ...dto, id });
  }

  @Delete(':id')
  @RequirePerm({ domain: 'USER', op: 'DELETE', checkScope: false, objectType: AUDIT_OBJECT.USER })
  @Audit({ action: 'PERM_CHANGE', objectType: AUDIT_OBJECT.USER, mandatory: true })
  public async disable(
    @Param('id') id: string,
    @CurrentUser('userId') operatorId: string,
  ): Promise<{ disabled: boolean }> {
    return this.admin.disable(id, operatorId);
  }

  /** 数据范围授权 */
  @Put(':id/scopes')
  @RequirePerm({ domain: 'USER', op: 'WRITE', checkScope: false, objectType: AUDIT_OBJECT.USER })
  @Audit({ action: 'PERM_CHANGE', objectType: AUDIT_OBJECT.USER, mandatory: true })
  public async updateScopes(
    @Param('id') id: string,
    @Body() dto: UpdateUserScopesBodyDto,
  ): Promise<UserDto> {
    return this.admin.updateUserScopes({ userId: id, scopes: dto.scopes });
  }

  /** 重置密码（管理员操作） */
  @Post(':id/reset-password')
  @RequirePerm({ domain: 'USER', op: 'WRITE', checkScope: false, objectType: AUDIT_OBJECT.USER })
  @Audit({ action: 'PERM_CHANGE', objectType: AUDIT_OBJECT.USER, mandatory: true })
  public async resetPassword(
    @Param('id') id: string,
    @Body() dto: { password: string },
  ): Promise<UserDto> {
    return this.admin.update({ id, password: dto.password });
  }
}

/**
 * 角色与权限矩阵接口（F-09）。
 */
@Controller('roles')
export class RoleController {
  constructor(private readonly admin: UserAdminService) {}

  @Get()
  @RequirePerm({ domain: 'USER', op: 'READ', checkScope: false, objectType: AUDIT_OBJECT.ROLE })
  public async list(): Promise<RoleDto[]> {
    return this.admin.listRoles();
  }

  @Patch(':id/permissions')
  @RequirePerm({ domain: 'USER', op: 'WRITE', checkScope: false, objectType: AUDIT_OBJECT.ROLE })
  @Audit({ action: 'PERM_CHANGE', objectType: AUDIT_OBJECT.ROLE, mandatory: true })
  public async updatePermissions(
    @Param('id') id: string,
    @Body() dto: UpdateRolePermissionsBodyDto,
  ): Promise<RoleDto> {
    return this.admin.updateRolePermissions({
      id,
      permissions: dto.permissions as unknown as RoleDto['permissions'],
    });
  }
}
