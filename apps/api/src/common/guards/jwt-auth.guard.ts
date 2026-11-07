import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { BizException, ErrorCode } from '@tianji/shared';
import { META_KEY, CTX_KEY } from '../constants/enums';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * JWT 认证守卫（全局）。
 * - `@Public()` 标记的接口直接放行；
 * - 其余接口必须携带 Bearer access token，校验通过后把用户快照挂到 request.currentUser。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {
    super();
  }

  public canActivate(context: ExecutionContext): boolean | Promise<boolean> | import('rxjs').Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(META_KEY.IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context) as boolean | Promise<boolean> | import('rxjs').Observable<boolean>;
  }

  /** Passport 校验通过后的用户对象注入 */
  public handleRequest<TUser = AuthenticatedUser>(
    err: unknown,
    user: TUser | false | null,
    info: unknown,
    _context: ExecutionContext,
  ): TUser {
    if (err) {
      this.logger.warn(`JWT 校验异常: ${(err as Error)?.message ?? String(err)}`);
      if (err instanceof BizException) throw err;
      throw new BizException(ErrorCode.UNAUTHORIZED, '登录凭证无效，请重新登录');
    }
    if (!user) {
      const reason =
        info && typeof info === 'object' && 'message' in info
          ? String((info as { message: unknown }).message)
          : '';
      if (reason.includes('expired') || reason.includes('jwt expired')) {
        throw new BizException(ErrorCode.TOKEN_EXPIRED);
      }
      throw new BizException(ErrorCode.UNAUTHORIZED);
    }
    return user;
  }

  /** 供 Controller 取用户（也可用 @CurrentUser） */
  public static attach(context: ExecutionContext, user: AuthenticatedUser): void {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    req[CTX_KEY.USER] = user;
  }
}
