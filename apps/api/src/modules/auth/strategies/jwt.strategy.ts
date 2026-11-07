import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { BizException, ErrorCode, type PermissionSnapshot } from '@tianji/shared';
import type { AuthenticatedUser, JwtPayload } from '../../../common/types/authenticated-user';
import { UserService } from '../../user/user.service';
import type { AppConfig } from '../../../config/configuration';

/**
 * JWT 策略：校验 access token 并把「最新权限快照」挂到 request.user。
 *
 * 设计取舍：token 内嵌快照用于快速判定，但每次请求仍从缓存（5min TTL）取最新快照，
 * 保证「权限变更 5 分钟内生效」（PRD F-09）；缓存命中时无数据库开销。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly userService: UserService,
  ) {
    const jwt = config.get<AppConfig['jwt']>('jwt');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwt?.accessSecret ?? 'dev_access_secret_change_me_32chars',
    });
  }

  public async validate(
    payload: JwtPayload & { snapshot?: PermissionSnapshot },
  ): Promise<AuthenticatedUser> {
    if (!payload || payload.type !== 'access') {
      throw new BizException(ErrorCode.TOKEN_INVALID, '令牌类型不正确');
    }

    const user = await this.userService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在或已被删除');
    }
    this.userService.assertUserUsable(user);

    // 以服务端快照为准（缓存 5 min）
    const snapshot = await this.userService.getSnapshot(payload.sub);

    return {
      ...snapshot,
      sessionId: payload.sessionId,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}
