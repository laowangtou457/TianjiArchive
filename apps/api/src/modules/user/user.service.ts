import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import {
  BizException,
  ErrorCode,
  PERMISSION_DOMAIN_VALUES,
  type PermissionGrant,
  type PermissionSnapshot,
  type RoleCode,
  SecurityLevel,
  UserStatus,
} from '@tianji/shared';
import { AppUser } from '../../infra/database/entities/user.entity';
import { Role } from '../../infra/database/entities/role.entity';
import { UserDataScope } from '../../infra/database/entities/user-data-scope.entity';
import { CACHE_KEY, CACHE_TTL } from '../../common/constants/enums';
import { RedisService } from '../../infra/redis/redis.module';
import { ParamService } from '../param/param.service';
import type { AppConfig } from '../../config/configuration';

/**
 * 用户服务：账号查询、密码校验与策略、权限快照构建。
 *
 * 密码策略（PRD F-09）与权限缓存（PRD 5.5 C-5）：
 *  - bcrypt 加盐，rounds 来自环境配置（非业务参数）；
 *  - 最短长度 / 有效期 / 失败阈值 / 锁定时长 全部来自 sys_param（security 组直读）；
 *  - 权限快照 key 带版本号，权限变更即时生效（TTL 仅兜底）。
 */
@Injectable()
export class UserService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserService.name);

  /** 进程级权限快照缓存（key 已含版本号，广播失效时按键清理） */
  private readonly localSnapshotCache = new Map<string, PermissionSnapshot>();

  /** 权限失效订阅者 */
  private permSubscriber: ReturnType<RedisService['duplicateForSubscribe']> | null = null;

  constructor(
    @InjectRepository(AppUser) private readonly userRepo: Repository<AppUser>,
    @InjectRepository(Role) private readonly roleRepo: Repository<Role>,
    @InjectRepository(UserDataScope) private readonly scopeRepo: Repository<UserDataScope>,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly paramService: ParamService,
  ) {}

  /** 按用户名查询（含角色） */
  public async findByUsername(username: string): Promise<AppUser | null> {
    return this.userRepo.findOne({ where: { username } });
  }

  /** 按 ID 查询（含角色） */
  public async findById(id: string): Promise<AppUser | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  /** 查询用户的角色实体 */
  public async findRoles(userId: string): Promise<Role[]> {
    const user = await this.userRepo
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.roles', 'r')
      .where('u.id = :userId', { userId })
      .getOne();
    return user?.roles ?? [];
  }

  /** 查询用户数据范围 */
  public async findScopes(userId: string): Promise<UserDataScope[]> {
    return this.scopeRepo.find({ where: { userId } });
  }

  /** 密码哈希 */
  public async hashPassword(plain: string): Promise<string> {
    const rounds = this.config.get<AppConfig['security']>('security')?.bcryptRounds ?? 10;
    return bcrypt.hash(plain, rounds);
  }

  /** 密码比对 */
  public async verifyPassword(plain: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plain, hash);
    } catch {
      return false;
    }
  }

  /**
   * 密码强度校验（参数化：`security.password_min_length`，security 组直读库）。
   * 规则：长度 ≥ 参数值，且至少包含字母与数字两类字符。
   */
  public async assertPasswordPolicy(plain: string): Promise<void> {
    const min = await this.readSecurityInt('security.password_min_length', 10);
    if (typeof plain !== 'string' || plain.length < min) {
      throw new BizException(ErrorCode.PASSWORD_POLICY, `密码长度不得少于 ${min} 位`);
    }
    const hasLetter = /[A-Za-z]/.test(plain);
    const hasDigit = /\d/.test(plain);
    if (!hasLetter || !hasDigit) {
      throw new BizException(ErrorCode.PASSWORD_POLICY, '密码必须同时包含字母与数字');
    }
    const weak = ['12345678', 'password', 'admin123', 'tianji123'];
    if (weak.some((w) => plain.toLowerCase().includes(w))) {
      throw new BizException(ErrorCode.PASSWORD_POLICY, '密码过于简单，请更换更复杂的口令');
    }
  }

  /** 密码是否过期（参数 `security.password_expire_days`，0=永不过期） */
  public async isPasswordExpired(user: AppUser): Promise<boolean> {
    const days = await this.readSecurityInt('security.password_expire_days', 90);
    if (days <= 0) return false; // 0 = 永不过期
    if (!user.pwdChangedAt) return true;
    const elapsed = Date.now() - new Date(user.pwdChangedAt).getTime();
    return elapsed > days * 86400 * 1000;
  }

  /** 记录登录失败（参数化阈值 + 锁定时长；Redis 计数用于快速短路） */
  public async recordLoginFailure(user: AppUser): Promise<void> {
    const maxFailed = await this.readSecurityInt('security.login_fail_lock_count', 5);
    const lockMinutes = await this.readSecurityInt('security.login_lock_min', 30);

    const failedCount = (user.failedCount ?? 0) + 1;
    const patch: Partial<AppUser> = { failedCount };
    if (failedCount >= maxFailed) {
      patch.lockedUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
      patch.status = UserStatus.LOCKED;
    }
    await this.userRepo.update({ id: user.id }, patch);
    await this.redis.incrWithTtl(`${CACHE_KEY.LOGIN_FAILED}${user.username}`, lockMinutes * 60);
  }

  /**
   * 读取 security 组整数参数（直读库），异常一律回落出厂值。
   *
   * 为什么包一层：security 组在登录热路径上，参数服务若因 DB 抖动抛错，
   * 不能把「登录」一起搞挂——安全参数退化为默认值比拒绝服务更可接受
   * （默认值是 PRD 封版口径，不是弱化）。
   */
  private async readSecurityInt(key: string, fallback: number): Promise<number> {
    try {
      const v = await this.paramService.getInt(key);
      return Number.isFinite(v) ? v : fallback;
    } catch (err) {
      this.logger.error(`读取安全参数 ${key} 失败，回落 ${fallback}: ${(err as Error).message}`);
      return fallback;
    }
  }

  /** 登录成功：重置失败计数并记录登录时间 */
  public async recordLoginSuccess(user: AppUser, ip: string): Promise<void> {
    await this.userRepo.update(
      { id: user.id },
      { failedCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip },
    );
    await this.redis.del(`${CACHE_KEY.LOGIN_FAILED}${user.username}`);
    await this.invalidateSnapshot(user.id);
  }

  /** 校验账号可用性（状态 + 锁定） */
  public assertUserUsable(user: AppUser): void {
    if (user.status === UserStatus.DISABLED) {
      throw new BizException(ErrorCode.ACCOUNT_DISABLED);
    }
    if (user.status === UserStatus.LOCKED) {
      if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
        throw new BizException(
          ErrorCode.ACCOUNT_LOCKED,
          `账号已锁定，请于 ${new Date(user.lockedUntil).toLocaleString('zh-CN')} 后重试`,
        );
      }
    }
  }

  /**
   * 构建权限快照（核心）：合并多角色的功能域授权。
   *
   * 合并策略（最宽松优先，避免多角色互相削弱）：
   *  - mode：OWNER 取最宽松（FULL > LIMITED > READONLY > NONE）；
   *  - ops：取并集；
   *  - scoped/levelCapped：任一角色为 false 则为 false（更宽松）。
   */
  public async buildSnapshot(user: AppUser): Promise<PermissionSnapshot> {
    const roles = await this.findRoles(user.id);
    const scopes = await this.findScopes(user.id);

    const merged: Partial<Record<string, PermissionGrant>> = {};
    const modeRank: Record<string, number> = { NONE: 0, READONLY: 1, LIMITED: 2, FULL: 3 };

    for (const role of roles) {
      const grants = Array.isArray(role.permissions) ? role.permissions : [];
      for (const grant of grants) {
        if (!grant || !PERMISSION_DOMAIN_VALUES.includes(grant.domain)) continue;
        const existing = merged[grant.domain];
        if (!existing) {
          merged[grant.domain] = {
            domain: grant.domain,
            ops: [...(grant.ops ?? [])],
            mode: grant.mode ?? 'NONE',
            scoped: grant.scoped ?? false,
            levelCapped: grant.levelCapped ?? true,
          };
          continue;
        }
        const ops = new Set([...(existing.ops ?? []), ...(grant.ops ?? [])]);
        existing.ops = Array.from(ops);
        if ((modeRank[grant.mode ?? 'NONE'] ?? 0) > (modeRank[existing.mode] ?? 0)) {
          existing.mode = grant.mode ?? existing.mode;
        }
        existing.scoped = Boolean(existing.scoped) && Boolean(grant.scoped);
        existing.levelCapped = Boolean(existing.levelCapped) && (grant.levelCapped ?? true);
      }
    }

    // 数据范围展开
    const hasAll = scopes.some((s) => s.scopeType === 'ALL');
    const fondsIds = hasAll
      ? null
      : scopes.filter((s) => s.scopeType === 'FONDS' && s.scopeRefId).map((s) => s.scopeRefId as string);
    const orgIds = hasAll
      ? null
      : scopes.filter((s) => s.scopeType === 'ORG' && s.scopeRefId).map((s) => s.scopeRefId as string);
    const selfOnly = !hasAll && scopes.some((s) => s.scopeType === 'SELF');

    // 若用户既无 ALL 也无任何具体范围，则默认 SELF（最小授权原则）
    const hasAnyScope = scopes.length > 0;
    const effectiveSelfOnly = hasAnyScope ? selfOnly : true;
    const effectiveFonds = hasAll ? null : hasAnyScope && (fondsIds?.length ?? 0) > 0 ? fondsIds : hasAnyScope ? [] : [];
    const effectiveOrgs = hasAll ? null : hasAnyScope && (orgIds?.length ?? 0) > 0 ? orgIds : hasAnyScope ? [] : [];

    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      roles: roles.map((r) => r.code as RoleCode),
      grants: merged as PermissionSnapshot['grants'],
      maxSecurityLevel: (user.maxSecurityLevel ?? SecurityLevel.PUBLIC) as SecurityLevel,
      scopes: scopes.map((s) => ({
        scopeType: s.scopeType,
        scopeRefId: s.scopeRefId,
      })),
      fondsIds: hasAll ? null : effectiveFonds,
      orgIds: hasAll ? null : effectiveOrgs,
      selfOnly: effectiveSelfOnly,
    };
  }

  /**
   * 读取权限快照（**带版本号缓存 + 主动失效**，PRD 5.5 C-5 / F-09）。
   *
   * 缓存 key 形如 `perm:{userId}:v3`，版本号来自 `perm_ver:{userId}` 计数键：
   *  - 权限变更 → 计数键 INCR → 版本号 +1 → 旧 key 从此读不到（天然失效）；
   *  - 不需要 SCAN 删除，也不受「多实例删除时序」影响（删除与重建的竞态不存在）；
   *  - TTL 仅兜底：即使版本号计数键被误删，过期后旧 key 也会自然消失。
   *
   * 真正让「撤权即时生效」成立的是版本号 + `perm:invalidate` 广播
   * （后者用于清掉各实例的进程内缓存），TTL 不承担生效职责。
   */
  public async getSnapshot(userId: string): Promise<PermissionSnapshot> {
    const version = await this.currentPermVersion(userId);
    const cacheKey = this.snapshotKey(userId, version);

    const localHit = this.localSnapshotCache.get(cacheKey);
    if (localHit) return localHit;

    const cached = await this.redis.getJson<PermissionSnapshot>(cacheKey);
    if (cached) {
      this.localSnapshotCache.set(cacheKey, cached);
      return cached;
    }

    const user = await this.findById(userId);
    if (!user) throw new BizException(ErrorCode.UNAUTHORIZED, '用户不存在或已被删除');
    const snapshot = await this.buildSnapshot(user);
    const ttl = await this.permissionCacheTtl();
    await this.redis.setJson(cacheKey, snapshot, ttl);
    this.localSnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  }

  /** 构造带版本号的快照缓存 key */
  private snapshotKey(userId: string, version: number): string {
    return `${CACHE_KEY.PERMISSION}${userId}:v${version}`;
  }

  /** 读取当前权限版本号（缺失视为 0） */
  private async currentPermVersion(userId: string): Promise<number> {
    return this.redis.getCounter(`${CACHE_KEY.PERMISSION_VERSION}${userId}`);
  }

  /** 权限快照 TTL：来自参数 `security.permission_cache_ttl_seconds`，仅兜底 */
  private async permissionCacheTtl(): Promise<number> {
    const fallback = CACHE_TTL.PERMISSION;
    if (!this.paramService) return fallback;
    try {
      const v = await this.paramService.getInt('security.permission_cache_ttl_seconds');
      return Number.isFinite(v) && v >= 0 ? v : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * 失效快照缓存 —— **主动失效的唯一入口**（权限/角色/数据范围变更后必须调用）。
   *
   * 两步走（缺一不可）：
   *  1) `perm_ver:{userId}` INCR：让本实例与所有实例「下一次读取」自然落空并重建；
   *  2) `perm:invalidate` 广播：通知各实例清掉进程内缓存（跨实例才需要）；
   *  3) 顺手删掉本实例已知的旧 key（避免 Redis 里残留，仅清理不承担生效职责）。
   *
   * 传空 userId 表示全量失效（字典/角色矩阵级变更），走 SCAN 清理。
   */
  public async invalidateSnapshot(userId?: string): Promise<void> {
    if (userId) {
      let version = 0;
      try {
        version = await this.redis.incr(`${CACHE_KEY.PERMISSION_VERSION}${userId}`);
        await this.redis.expire(
          `${CACHE_KEY.PERMISSION_VERSION}${userId}`,
          CACHE_TTL.PERMISSION_VERSION,
        );
      } catch (err) {
        // 版本号拿不到是严重问题：降级为「直接删除旧 key + 广播」，仍有失效效果
        this.logger.error(`权限版本号自增失败，降级为清理旧快照: ${(err as Error).message}`);
        version = 0;
      }
      // 清理本实例进程缓存中该用户的全部版本
      for (const key of [...this.localSnapshotCache.keys()]) {
        if (key.startsWith(`${CACHE_KEY.PERMISSION}${userId}:v`)) {
          this.localSnapshotCache.delete(key);
        }
      }
      if (version > 0) {
        await this.redis.del(this.snapshotKey(userId, Math.max(0, version - 1)));
      } else {
        await this.redis.delByPrefix(`${CACHE_KEY.PERMISSION}${userId}:v`);
      }
      await this.redis.publish(
        CACHE_KEY.PERMISSION_CHANNEL,
        JSON.stringify({ userIds: [userId], at: Date.now() }),
      );
      return;
    }

    // 全量失效：清进程缓存 + 清 Redis + 广播
    this.localSnapshotCache.clear();
    await this.redis.delByPrefix(CACHE_KEY.PERMISSION);
    await this.redis.delByPrefix(CACHE_KEY.PERMISSION_VERSION);
    await this.redis.publish(
      CACHE_KEY.PERMISSION_CHANNEL,
      JSON.stringify({ userIds: [], all: true, at: Date.now() }),
    );
  }

  /** 处理权限失效广播（其它实例的变更通知） */
  private handlePermissionInvalidate(raw: string): void {
    let payload: { userIds?: string[]; all?: boolean } | null = null;
    try {
      payload = JSON.parse(raw) as { userIds?: string[]; all?: boolean };
    } catch {
      payload = null;
    }
    if (!payload || payload.all || !Array.isArray(payload.userIds)) {
      this.localSnapshotCache.clear();
      return;
    }
    for (const userId of payload.userIds) {
      for (const key of [...this.localSnapshotCache.keys()]) {
        if (key.startsWith(`${CACHE_KEY.PERMISSION}${userId}:v`)) {
          this.localSnapshotCache.delete(key);
        }
      }
    }
  }

  /** 生命周期：订阅权限失效通道（多实例下清进程缓存） */
  public async onModuleInit(): Promise<void> {
    try {
      this.permSubscriber = this.redis.duplicateForSubscribe();
      await this.permSubscriber.subscribe(CACHE_KEY.PERMISSION_CHANNEL);
      this.permSubscriber.on('message', (channel: string, message: string) => {
        if (channel === CACHE_KEY.PERMISSION_CHANNEL) this.handlePermissionInvalidate(message);
      });
      this.logger.log(`已订阅权限失效通道 ${CACHE_KEY.PERMISSION_CHANNEL}`);
    } catch (err) {
      // 订阅失败不影响本实例正确性（版本号已能保证本实例读到最新权限），
      // 仅使跨实例进程缓存失去即时性 —— TTL 兜底。
      this.logger.error(`订阅权限失效通道失败: ${(err as Error).message}`);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    try {
      if (this.permSubscriber) {
        await this.permSubscriber.unsubscribe(CACHE_KEY.PERMISSION_CHANNEL);
        await this.permSubscriber.quit();
        this.permSubscriber = null;
      }
    } catch {
      /* 退出期忽略 */
    }
  }

  /** 会话 ID（用于刷新令牌吊销追踪） */
  public newSessionId(): string {
    return randomUUID();
  }

  /** 更新密码哈希（改密/重置密码后调用，重置失败计数与锁定期） */
  public async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.userRepo.update(
      { id: userId },
      {
        passwordHash,
        pwdChangedAt: new Date(),
        failedCount: 0,
        lockedUntil: null,
        status: UserStatus.ACTIVE,
      },
    );
  }

  /** 刷新令牌指纹（存入 Redis 吊销表，logout 时删除） */
  public tokenFingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 32);
  }
}
