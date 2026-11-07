import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BizException,
  ErrorCode,
  SecurityLevel,
  UserStatus,
  type CreateUserDto,
  type RoleDto,
  type UpdateRolePermissionsDto,
  type UpdateUserDto,
  type UpdateUserScopesDto,
  type UserDto,
  type PermissionGrant,
} from '@tianji/shared';
import { AppUser } from '../../infra/database/entities/user.entity';
import { Role } from '../../infra/database/entities/role.entity';
import { UserDataScope } from '../../infra/database/entities/user-data-scope.entity';
import { UserService } from './user.service';

/**
 * 用户与权限管理服务（F-09）。
 * 关键约束：
 *  - 权限变更后立即失效权限快照缓存 → 5 分钟内生效（实际是秒级）；
 *  - 内置角色不可删除；用户至少保留一个 R0 账号（防自锁）；
 *  - 修改用户角色/密级/数据范围统一记录 PERM_CHANGE 审计。
 */
@Injectable()
export class UserAdminService {
  private readonly logger = new Logger(UserAdminService.name);

  constructor(
    @InjectRepository(AppUser) private readonly userRepo: Repository<AppUser>,
    @InjectRepository(Role) private readonly roleRepo: Repository<Role>,
    @InjectRepository(UserDataScope) private readonly scopeRepo: Repository<UserDataScope>,
    private readonly userService: UserService,
  ) {}

  /** 用户列表（分页 + 关键字） */
  public async list(params: {
    page: number;
    size: number;
    keyword?: string;
    status?: UserStatus;
  }): Promise<{ list: UserDto[]; total: number; page: number; size: number }> {
    const page = Math.max(1, params.page || 1);
    const size = Math.min(100, Math.max(1, params.size || 20));
    const qb = this.userRepo.createQueryBuilder('u').orderBy('u.createdAt', 'DESC');
    if (params.keyword) {
      qb.andWhere('(u.username ILIKE :kw OR u.displayName ILIKE :kw)', {
        kw: `%${params.keyword}%`,
      });
    }
    if (params.status) {
      qb.andWhere('u.status = :status', { status: params.status });
    }
    qb.skip((page - 1) * size).take(size);
    const [rows, total] = await qb.getManyAndCount();
    const dtos = await Promise.all(rows.map((u) => this.toDto(u)));
    return { list: dtos, total, page, size };
  }

  /** 用户详情 */
  public async detail(id: string): Promise<UserDto> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在');
    return this.toDto(user);
  }

  /** 新建用户 */
  public async create(dto: CreateUserDto): Promise<UserDto> {
    const existing = await this.userService.findByUsername(dto.username);
    if (existing) {
      throw new BizException(ErrorCode.CONFLICT, `用户名「${dto.username}」已存在`);
    }
    await this.userService.assertPasswordPolicy(dto.password);
    const hash = await this.userService.hashPassword(dto.password);

    const user = this.userRepo.create({
      username: dto.username,
      passwordHash: hash,
      displayName: dto.displayName,
      status: dto.status ?? UserStatus.ACTIVE,
      maxSecurityLevel: dto.maxSecurityLevel ?? SecurityLevel.PUBLIC,
      pwdChangedAt: new Date(),
    });
    const saved = await this.userRepo.save(user);

    if (dto.roleIds && dto.roleIds.length > 0) {
      const roles = await this.roleRepo.find({ where: { id: In(dto.roleIds) } });
      saved.roles = roles;
      await this.userRepo.save(saved);
    }
    if (dto.scopes && dto.scopes.length > 0) {
      await this.replaceScopes(saved.id, dto.scopes);
    } else {
      // 默认最小授权：仅本人数据
      await this.scopeRepo.save(
        this.scopeRepo.create({ userId: saved.id, scopeType: 'SELF', scopeRefId: null }),
      );
    }
    await this.userService.invalidateSnapshot(saved.id);
    this.logger.log(`新建用户 ${saved.username}（${saved.id}）`);
    return this.detail(saved.id);
  }

  /** 更新用户（含角色/密级/状态/密码重置） */
  public async update(dto: UpdateUserDto): Promise<UserDto> {
    const user = await this.userRepo.findOne({ where: { id: dto.id } });
    if (!user) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在');

    const patch: Partial<AppUser> = {};
    if (dto.displayName !== undefined) patch.displayName = dto.displayName;
    if (dto.status !== undefined) {
      if (dto.status === UserStatus.ACTIVE) {
        patch.lockedUntil = null;
        patch.failedCount = 0;
      }
      patch.status = dto.status;
    }
    if (dto.maxSecurityLevel !== undefined) patch.maxSecurityLevel = dto.maxSecurityLevel;
    if (dto.password) {
      await this.userService.assertPasswordPolicy(dto.password);
      patch.passwordHash = await this.userService.hashPassword(dto.password);
      patch.pwdChangedAt = new Date();
      patch.failedCount = 0;
      patch.lockedUntil = null;
    }
    if (Object.keys(patch).length > 0) {
      await this.userRepo.update({ id: dto.id }, patch);
    }

    if (dto.roleIds) {
      // 防自锁：不允许移除最后一个 R0 角色
      await this.assertNotRemovingLastAdmin(dto.id, dto.roleIds);
      const roles = await this.roleRepo.find({ where: { id: In(dto.roleIds) } });
      const full = await this.userRepo.findOne({ where: { id: dto.id } });
      if (!full) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在');
      full.roles = roles;
      await this.userRepo.save(full);
    }

    await this.userService.invalidateSnapshot(dto.id);
    return this.detail(dto.id);
  }

  /** 删除用户（软策略：置为停用，保留审计追溯） */
  public async disable(id: string, operatorId: string): Promise<{ disabled: boolean }> {
    if (id === operatorId) {
      throw new BizException(ErrorCode.BAD_REQUEST, '不能停用当前登录账号');
    }
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在');
    const roles = await this.userService.findRoles(id);
    if (roles.some((r) => r.code === 'R0')) {
      await this.assertNotRemovingLastAdmin(id, []);
    }
    await this.userRepo.update({ id }, { status: UserStatus.DISABLED });
    await this.userService.invalidateSnapshot(id);
    return { disabled: true };
  }

  /** 角色列表 */
  public async listRoles(): Promise<RoleDto[]> {
    const roles = await this.roleRepo.find({ order: { code: 'ASC' } });
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
      builtin: r.builtin,
    }));
  }

  /** 更新角色权限矩阵（F-09 权限矩阵页） */
  public async updateRolePermissions(dto: UpdateRolePermissionsDto): Promise<RoleDto> {
    const role = await this.roleRepo.findOne({ where: { id: dto.id } });
    if (!role) throw new BizException(ErrorCode.NOT_FOUND, '角色不存在');
    const sanitized = this.sanitizeGrants(dto.permissions);
    await this.roleRepo.update({ id: dto.id }, { permissions: sanitized });

    // 该角色下所有用户快照失效
    const users = await this.userRepo
      .createQueryBuilder('u')
      .innerJoin('u.roles', 'r', 'r.id = :roleId', { roleId: dto.id })
      .getMany();
    for (const u of users) {
      await this.userService.invalidateSnapshot(u.id);
    }
    this.logger.log(`角色 ${role.code} 权限更新，影响 ${users.length} 名用户`);
    return {
      id: role.id,
      code: role.code,
      name: role.name,
      permissions: sanitized,
      builtin: role.builtin,
    };
  }

  /** 更新用户数据范围授权 */
  public async updateUserScopes(dto: UpdateUserScopesDto): Promise<UserDto> {
    const user = await this.userRepo.findOne({ where: { id: dto.userId } });
    if (!user) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在');
    await this.replaceScopes(dto.userId, dto.scopes);
    await this.userService.invalidateSnapshot(dto.userId);
    return this.detail(dto.userId);
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private async replaceScopes(
    userId: string,
    scopes: Array<{ scopeType: 'ALL' | 'FONDS' | 'ORG' | 'SELF'; scopeRefId?: string | null }>,
  ): Promise<void> {
    await this.scopeRepo.delete({ userId });
    if (scopes.length === 0) return;
    const rows = scopes.map((s) =>
      this.scopeRepo.create({
        userId,
        scopeType: s.scopeType,
        scopeRefId: s.scopeType === 'ALL' || s.scopeType === 'SELF' ? null : (s.scopeRefId ?? null),
      }),
    );
    await this.scopeRepo.save(rows);
  }

  /** 防止移除最后一个系统管理员 */
  private async assertNotRemovingLastAdmin(userId: string, newRoleIds: string[]): Promise<void> {
    const r0 = await this.roleRepo.findOne({ where: { code: 'R0' } });
    if (!r0) return;
    if (newRoleIds.includes(r0.id)) return;

    const adminCount = await this.userRepo
      .createQueryBuilder('u')
      .innerJoin('u.roles', 'r', 'r.code = :code', { code: 'R0' })
      .andWhere('u.status = :st', { st: UserStatus.ACTIVE })
      .getCount();
    if (adminCount <= 1) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        '系统至少需要保留一个启用状态的系统管理员（R0），操作被拒绝',
      );
    }
  }

  /** 清洗权限声明（仅保留合法域与操作） */
  private sanitizeGrants(grants: PermissionGrant[]): PermissionGrant[] {
    const domainSet = new Set([
      'FONDS', 'VOLUME', 'ITEM', 'DANGHAO_RULE', 'ARCHIVE_CONFIRM', 'SEARCH',
      'SEARCH_INTERNAL', 'FILE', 'PREVIEW', 'BORROW_APPLY', 'BORROW_APPROVE',
      'BORROW_RETURN', 'REPORT', 'COMPILATION', 'APPRAISAL', 'RECYCLE', 'USER',
      'AUDIT_LOG', 'BACKUP', 'IMPORT_EXPORT', 'PARAM', 'DICT', 'KB',
    ]);
    const opSet = new Set(['READ', 'WRITE', 'APPROVE', 'DELETE', 'EXPORT']);
    const modeSet = new Set(['FULL', 'LIMITED', 'READONLY', 'NONE']);
    return (Array.isArray(grants) ? grants : [])
      .filter((g) => g && domainSet.has(g.domain as string))
      .map((g) => ({
        domain: g.domain,
        ops: (g.ops ?? []).filter((o) => opSet.has(o as string)),
        mode: modeSet.has(g.mode as string) ? g.mode : 'NONE',
        scoped: Boolean(g.scoped),
        levelCapped: g.levelCapped !== false,
      }));
  }

  private async toDto(user: AppUser): Promise<UserDto> {
    const roles = await this.userService.findRoles(user.id);
    const scopes = await this.userService.findScopes(user.id);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
      maxSecurityLevel: user.maxSecurityLevel,
      roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
      scopes: scopes.map((s) => ({
        id: s.id,
        scopeType: s.scopeType,
        scopeRefId: s.scopeRefId,
      })),
      lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
      createdAt: new Date(user.createdAt).toISOString(),
    };
  }
}
