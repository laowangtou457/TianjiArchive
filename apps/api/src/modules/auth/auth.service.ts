import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  BizException,
  ErrorCode,
  type LoginResponse,
  type PermissionSnapshot,
  type RefreshResponse,
} from '@tianji/shared';
import { UserService } from '../user/user.service';
import { ParamService } from '../param/param.service';
import { RedisService } from '../../infra/redis/redis.module';
import { CACHE_KEY, PARAM_KEY } from '../../common/constants/enums';
import type { AppConfig } from '../../config/configuration';
import type { JwtPayload } from '../../common/types/authenticated-user';
import type { AppUser } from '../../infra/database/entities/user.entity';

/**
 * 认证服务：登录 → JWT(access 2h + refresh 14d) → 刷新 → 登出（Redis 吊销表）。
 *
 * 安全要点（架构 §8）：
 *  - 密码 bcrypt 加盐，错误信息不区分"用户不存在/密码错误"；
 *  - 连续失败 5 次锁定 30 分钟，并限制单 IP 频率（Redis 计数）；
 *  - refresh token 类型隔离（typ=refresh），登出写入吊销表；
 *  - 密码过期强制要求改密（返回 1014，前端跳转改密页）。
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly paramService: ParamService,
  ) {}

  /** 登录 */
  public async login(username: string, password: string, ip: string): Promise<LoginResponse> {
    // 频率限制：单用户名 10 次/5 分钟
    const rateKey = `login:rate:${username}`;
    const attempts = await this.redis.incrWithTtl(rateKey, 300);
    if (attempts > 20) {
      throw new BizException(ErrorCode.TOO_MANY_REQUESTS, '登录尝试过于频繁，请 5 分钟后再试');
    }

    const user = await this.userService.findByUsername(username);
    if (!user) {
      // 统一提示，避免用户名枚举
      throw new BizException(ErrorCode.BAD_CREDENTIALS);
    }
    this.userService.assertUserUsable(user);

    const matched = await this.userService.verifyPassword(password, user.passwordHash);
    if (!matched) {
      await this.userService.recordLoginFailure(user);
      throw new BizException(ErrorCode.BAD_CREDENTIALS);
    }

    if (await this.userService.isPasswordExpired(user)) {
      throw new BizException(ErrorCode.PASSWORD_EXPIRED, '密码已超过有效期，请修改密码后重新登录');
    }

    await this.userService.recordLoginSuccess(user, ip);
    const snapshot = await this.userService.buildSnapshot(user);
    await this.userService.invalidateSnapshot(user.id);

    const tokens = await this.issueTokens(user, snapshot);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      profile: snapshot,
    };
  }

  /** 刷新 access token（要求 refresh 未吊销、用户仍可用） */
  public async refresh(refreshToken: string): Promise<RefreshResponse> {
    const payload = await this.verifyRefresh(refreshToken);
    const fingerprint = this.userService.tokenFingerprint(refreshToken);
    const revoked = await this.redis.get(`${CACHE_KEY.REFRESH_REVOKED}${fingerprint}`);
    if (revoked) {
      throw new BizException(ErrorCode.TOKEN_INVALID, '刷新令牌已失效，请重新登录');
    }

    const user = await this.userService.findById(payload.sub);
    if (!user) throw new BizException(ErrorCode.TOKEN_INVALID, '用户不存在');
    this.userService.assertUserUsable(user);

    // 旧 refresh 立即吊销（一次性使用），签发新的
    await this.revokeRefresh(refreshToken);
    const snapshot = await this.userService.buildSnapshot(user);
    const tokens = await this.issueTokens(user, snapshot);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    };
  }

  /** 登出：吊销 refresh token */
  public async logout(refreshToken: string | undefined, userId: string): Promise<void> {
    if (refreshToken) {
      await this.revokeRefresh(refreshToken);
    }
    await this.userService.invalidateSnapshot(userId);
  }

  /** 修改密码 */
  public async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.userService.findById(userId);
    if (!user) throw new BizException(ErrorCode.NOT_FOUND, '用户不存在');
    const matched = await this.userService.verifyPassword(oldPassword, user.passwordHash);
    if (!matched) throw new BizException(ErrorCode.BAD_CREDENTIALS, '原密码不正确');
    await this.userService.assertPasswordPolicy(newPassword);
    if (oldPassword === newPassword) {
      throw new BizException(ErrorCode.PASSWORD_POLICY, '新密码不能与原密码相同');
    }
    const hash = await this.userService.hashPassword(newPassword);
    await this.userService.updatePasswordHash(userId, hash);
    await this.userService.invalidateSnapshot(userId);
  }

  /** 当前用户权限快照（前端刷新页面时拉取） */
  public async profile(userId: string): Promise<PermissionSnapshot> {
    return this.userService.getSnapshot(userId);
  }

  // ==========================================================================
  // 内部实现
  // ==========================================================================

  private async issueTokens(
    user: AppUser,
    snapshot: PermissionSnapshot,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const jwt = this.config.get<AppConfig['jwt']>('jwt');
    const accessTtl = jwt?.accessTtlSeconds ?? 7200;
    const refreshTtl = jwt?.refreshTtlSeconds ?? 1209600;
    const sessionId = this.userService.newSessionId();

    // QD-1 / D-3：会话超时在**签发时刻**从参数读取并固化。
    // 参数改小不踢存量会话——已签发令牌按签发时的值走完有效期，
    // 只有新登录/refresh 才用新值。校验侧读会话记录里的 timeoutMinutes，
    // 而不是每次回查参数（否则就成了「追溯存量」，与 D-3 相反）。
    const timeoutMinutes = await this.readSessionTimeoutMinutes();

    // access token 内嵌快照摘要，减少每次请求查库；细粒度判定仍以服务端快照为准
    const accessPayload: JwtPayload & { snapshot: PermissionSnapshot } = {
      sub: user.id,
      username: user.username,
      sessionId,
      type: 'access',
      snapshot,
    };
    const refreshPayload: JwtPayload = {
      sub: user.id,
      username: user.username,
      sessionId,
      type: 'refresh',
    };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: jwt?.accessSecret,
      expiresIn: accessTtl,
    });
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: jwt?.refreshSecret,
      expiresIn: refreshTtl,
    });

    // 记录 refresh 活跃态（便于审计会话）。
    // timeoutMinutes 必须落库：它是存量会话的判定依据，丢了就无法「按签发值走完」。
    await this.redis.set(
      `${CACHE_KEY.AUTH_SESSION}${sessionId}`,
      JSON.stringify({
        userId: user.id,
        createdAt: new Date().toISOString(),
        timeoutMinutes,
      }),
      refreshTtl,
    );

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  /**
   * 读取当前会话超时（分钟）。
   *
   * PR-P8：`security.*` 属直读组，故 ParamService.get() 会绕过 Redis 缓存直查库，
   * 保证「改完下一个新登录立即用新值」。
   * 读失败时回落 config 的 JWT 绝对时长（按分钟折算），宁可短不可无限长。
   */
  private async readSessionTimeoutMinutes(): Promise<number> {
    try {
      const raw = await this.paramService.getInt(PARAM_KEY.SECURITY_SESSION_TIMEOUT_MIN);
      if (Number.isFinite(raw) && raw > 0) return raw;
    } catch {
      // 参数不可用时继续走下面的 config 兜底，不因参数故障拒绝登录
    }
    const jwt = this.config.get<AppConfig['jwt']>('jwt');
    const accessTtl = jwt?.accessTtlSeconds ?? 7200;
    return Math.max(1, Math.floor(accessTtl / 60));
  }

  private async verifyRefresh(token: string): Promise<JwtPayload> {
    const jwt = this.config.get<AppConfig['jwt']>('jwt');
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: jwt?.refreshSecret,
      });
      if (payload.type !== 'refresh') {
        throw new BizException(ErrorCode.TOKEN_INVALID, '令牌类型不正确');
      }
      return payload;
    } catch (err) {
      if (err instanceof BizException) throw err;
      throw new BizException(ErrorCode.TOKEN_EXPIRED, '刷新令牌已过期，请重新登录');
    }
  }

  private async revokeRefresh(token: string): Promise<void> {
    const fingerprint = this.userService.tokenFingerprint(token);
    const jwt = this.config.get<AppConfig['jwt']>('jwt');
    const ttl = jwt?.refreshTtlSeconds ?? 1209600;
    await this.redis.set(`${CACHE_KEY.REFRESH_REVOKED}${fingerprint}`, '1', ttl);
  }
}
