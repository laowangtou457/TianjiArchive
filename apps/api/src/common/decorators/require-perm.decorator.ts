import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { OperationType, PermissionDomain } from '@tianji/shared';
import type { Request } from 'express';
import { CTX_KEY, META_KEY } from '../constants/enums';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * 声明该接口无需认证（登录、刷新、健康检查）。
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(META_KEY.IS_PUBLIC, true);

/** 权限声明参数 */
export interface RequirePermOptions {
  /** 功能域 */
  domain: PermissionDomain;
  /** 操作类型 */
  op: OperationType;
  /**
   * 是否强制校验密级与数据范围。
   * 默认 true：Guard 会从请求体/查询参数中提取 securityLevel/fondsId 做即时校验；
   * 列表类接口建议 false，改由 Service 层通过 AccessFilterBuilder 做行级过滤。
   */
  checkScope?: boolean;
  /** 资源类型（用于审计） */
  objectType?: string;
}

/**
 * 权限四要素声明装饰器（角色 × 数据范围 × 密级 × 操作）。
 * 用法：`@RequirePerm({ domain: 'ITEM', op: 'WRITE' })`
 */
export const RequirePerm = (
  options: RequirePermOptions,
): MethodDecorator & ClassDecorator => SetMetadata(META_KEY.REQUIRE_PERM, options);

/** 审计元数据声明 */
export interface AuditMeta {
  action: string;
  objectType: string;
  /** 是否强制留痕（SEARCH/PREVIEW/DOWNLOAD 恒为 true，不可关闭） */
  mandatory?: boolean;
  /** 从请求中取对象 ID 的路径，如 'params.id' | 'body.itemId' */
  objectIdPath?: string;
}

/** 声明审计信息（覆盖默认推导） */
export const Audit = (meta: AuditMeta): MethodDecorator & ClassDecorator =>
  SetMetadata(META_KEY.AUDIT, meta);

/** 跳过审计（仅限非敏感接口，敏感动作会被强制覆盖） */
export const SkipAudit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(META_KEY.SKIP_AUDIT, true);

/**
 * 取当前登录用户。
 * 用法：`@CurrentUser() user: AuthenticatedUser` 或 `@CurrentUser('id') userId: string`
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { [CTX_KEY.USER]?: AuthenticatedUser }>();
    const user = request[CTX_KEY.USER];
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);

/** 取客户端真实 IP（考虑 Nginx 反代） */
export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(',')[0].trim();
  }
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
});
