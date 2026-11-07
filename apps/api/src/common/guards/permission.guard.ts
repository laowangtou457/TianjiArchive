import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  BizException,
  ErrorCode,
  canAccessLevel,
  canAccessScope,
  hasPermission,
  SecurityLevel,
  SECURITY_LEVEL_VALUES,
} from '@tianji/shared';
import type { Request } from 'express';
import { META_KEY, CTX_KEY } from '../constants/enums';
import type { RequirePermOptions } from '../decorators/require-perm.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * 权限四要素守卫（核心，架构 §8）。
 *
 * 判定顺序：
 *   1) 功能域权限（角色 → grants.ops 是否含该操作）；
 *   2) 密级（请求体/查询中的 securityLevel 是否 ≤ 用户密级上限）；
 *   3) 数据范围（请求中的 fondsId/orgId 是否在授权范围内）。
 *
 * 说明：列表检索类接口的行级过滤由 Service 通过 AccessFilterBuilder 完成，
 * 此处只做「入口级」拦截，避免把大量 ID 塞进请求。
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(META_KEY.IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const options = this.reflector.getAllAndOverride<RequirePermOptions | undefined>(
      META_KEY.REQUIRE_PERM,
      [context.getHandler(), context.getClass()],
    );
    // 未声明权限要求的接口：只要是登录用户即可访问（如 /auth/profile）
    if (!options) return true;

    const request = context.switchToHttp().getRequest<
      Request & { [CTX_KEY.USER]?: AuthenticatedUser }
    >();
    const user = request[CTX_KEY.USER];
    if (!user) {
      throw new BizException(ErrorCode.UNAUTHORIZED);
    }

    // -------------------------------------------------------------- 1) 功能域权限
    if (!hasPermission(user, options.domain, options.op)) {
      this.logger.warn(
        `越权拦截 user=${user.username} domain=${options.domain} op=${options.op} ${request.method} ${request.originalUrl}`,
      );
      throw new BizException(
        ErrorCode.FORBIDDEN,
        `无权限执行该操作（功能域 ${options.domain} / 操作 ${options.op}）`,
      );
    }

    if (options.checkScope === false) return true;

    // -------------------------------------------------------------- 2) 密级
    const requestedLevel = this.extractSecurityLevel(request);
    if (requestedLevel && !canAccessLevel(user, requestedLevel, options.domain)) {
      throw new BizException(
        ErrorCode.FORBIDDEN,
        `密级不足：当前上限 ${user.maxSecurityLevel}，请求密级 ${requestedLevel}`,
      );
    }

    // -------------------------------------------------------------- 3) 数据范围（仅当请求显式指定了全宗/机构）
    const ref = this.extractScope(request);
    if ((ref.fondsId || ref.orgId) && !canAccessScope(user, ref)) {
      throw new BizException(ErrorCode.FORBIDDEN, '超出授权数据范围（全宗/机构）');
    }

    return true;
  }

  /** 从 body/query/params 提取密级（写入类请求） */
  private extractSecurityLevel(request: Request): SecurityLevel | null {
    const candidates: unknown[] = [
      (request.body as Record<string, unknown> | undefined)?.securityLevel,
      (request.body as Record<string, unknown> | undefined)?.level,
      (request.query as Record<string, unknown> | undefined)?.securityLevel,
      (request.query as Record<string, unknown> | undefined)?.level,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && SECURITY_LEVEL_VALUES.includes(c as SecurityLevel)) {
        return c as SecurityLevel;
      }
    }
    return null;
  }

  /** 从 body/query 提取全宗/机构标识 */
  private extractScope(request: Request): {
    fondsId?: string | null;
    orgId?: string | null;
    createdBy?: string | null;
  } {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const pick = (key: string): string | null => {
      const v = body[key] ?? query[key];
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    return { fondsId: pick('fondsId'), orgId: pick('orgId') };
  }
}
