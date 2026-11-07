import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap, catchError, throwError } from 'rxjs';
import type { Request, Response } from 'express';
import {
  AuditAction,
  AuditResult,
  MANDATORY_AUDIT_ACTIONS,
  OperationType,
} from '@tianji/shared';
import type { AuditMeta, RequirePermOptions } from '../decorators/require-perm.decorator';
import { CTX_KEY, META_KEY } from '../constants/enums';
import type { AuthenticatedUser } from '../types/authenticated-user';
import { AuditLogService } from '../../modules/audit/audit-log.service';

/**
 * 审计日志拦截器（F-10，全局）。
 *
 * 设计要点：
 *  1) 只追加、异步写（不阻塞响应），失败只记日志不影响业务；
 *  2) SEARCH / PREVIEW / DOWNLOAD / LOGIN / PERM_CHANGE / APPROVE 等敏感动作
 *     **强制留痕**，`@SkipAudit()` 无法关闭（架构 §11）；
 *  3) 记录操作人、IP、对象、动作、结果、耗时、详情；
 *  4) 越权（403）同样留痕 —— 等保审计要求。
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditLogService: AuditLogService,
  ) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const handler = context.getHandler();
    const cls = context.getClass();
    const meta = this.reflector.get<AuditMeta | undefined>(META_KEY.AUDIT, handler);
    const skip = this.reflector.getAllAndOverride<boolean>(META_KEY.SKIP_AUDIT, [handler, cls]);
    const perm = this.reflector.getAllAndOverride<RequirePermOptions | undefined>(
      META_KEY.REQUIRE_PERM,
      [handler, cls],
    );
    const isPublic = this.reflector.getAllAndOverride<boolean>(META_KEY.IS_PUBLIC, [
      handler,
      cls,
    ]);

    const request = context.switchToHttp().getRequest<Request & { [CTX_KEY.USER]?: AuthenticatedUser }>();
    const response = context.switchToHttp().getResponse<Response>();

    const action = this.resolveAction(request, meta, perm, isPublic);
    const mandatory = MANDATORY_AUDIT_ACTIONS.includes(action);

    // 非敏感接口允许跳过；敏感动作强制留痕
    if (skip && !mandatory) return next.handle();
    // 无认证信息的公开接口（除登录本身）不记录
    const user = request[CTX_KEY.USER];
    if (!user && !isPublic) {
      return next.handle();
    }

    const startedAt = Date.now();
    const objectType = meta?.objectType ?? perm?.objectType ?? this.resolveObjectType(request);

    return next.handle().pipe(
      tap(() => {
        this.write({
          request,
          user,
          action,
          objectType,
          objectId: this.resolveObjectId(request, meta),
          result: response.statusCode >= 400 ? AuditResult.FAILURE : AuditResult.SUCCESS,
          durationMs: Date.now() - startedAt,
          detail: this.buildDetail(request, action),
        });
      }),
      catchError((err: unknown) => {
        const status = (err as { status?: number; httpStatus?: number })?.httpStatus
          ?? (err as { status?: number })?.status
          ?? 500;
        this.write({
          request,
          user,
          action,
          objectType,
          objectId: this.resolveObjectId(request, meta),
          result: status === 403 ? AuditResult.DENIED : AuditResult.FAILURE,
          durationMs: Date.now() - startedAt,
          detail: {
            ...this.buildDetail(request, action),
            error: (err as Error)?.message ?? String(err),
          },
        });
        return throwError(() => err);
      }),
    );
  }

  /** 动作推导：显式声明 > 权限操作类型 > HTTP 方法推断 */
  private resolveAction(
    request: Request,
    meta: AuditMeta | undefined,
    perm: RequirePermOptions | undefined,
    isPublic: boolean,
  ): AuditAction {
    if (meta?.action && this.isAuditAction(meta.action)) return meta.action as AuditAction;

    const method = request.method.toUpperCase();
    const path = request.route?.path ?? request.path ?? '';

    // 敏感动作按路由特征识别（保证强制留痕）
    if (path.includes('/preview')) return 'PREVIEW';
    if (path.includes('/download')) return 'DOWNLOAD';
    if (path.includes('/search')) return 'SEARCH';
    if (path.includes('/login')) return 'LOGIN';
    if (path.includes('/logout')) return 'LOGOUT';
    if (path.includes('/approve')) return 'APPROVE';
    if (path.includes('/void')) return 'VOID';
    if (path.includes('/restore')) return 'RESTORE';
    if (path.includes('/export')) return 'EXPORT';
    if (path.includes('/backup/run') || path.includes('/restore')) return 'BACKUP';
    if (path.includes('/scopes') || path.includes('/roles')) return 'PERM_CHANGE';

    if (perm?.op) {
      const map: Record<OperationType, AuditAction> = {
        READ: 'SEARCH',
        WRITE: method === 'POST' ? 'CREATE' : 'UPDATE',
        APPROVE: 'APPROVE',
        DELETE: 'DELETE',
        EXPORT: 'EXPORT',
      };
      if (isPublic) return method === 'POST' ? 'CREATE' : 'SEARCH';
      return map[perm.op];
    }

    switch (method) {
      case 'POST':
        return 'CREATE';
      case 'PUT':
      case 'PATCH':
        return 'UPDATE';
      case 'DELETE':
        return 'DELETE';
      default:
        return 'SEARCH';
    }
  }

  private resolveObjectType(request: Request): string {
    const path = request.originalUrl ?? request.url ?? '';
    const seg = path.split('?')[0].split('/').filter((s) => s.length > 0);
    // /api/<resource>/...
    return (seg[1] ?? 'UNKNOWN').toUpperCase();
  }

  private resolveObjectId(request: Request, meta: AuditMeta | undefined): string | null {
    if (meta?.objectIdPath) {
      const parts = meta.objectIdPath.split('.');
      let cur: unknown = request;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          cur = undefined;
          break;
        }
      }
      return cur === undefined || cur === null ? null : String(cur);
    }
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    return params.id ?? params.itemId ?? params.fileId ?? params.orderId ?? null;
  }

  /** 详情：记录查询串与写操作的关键字段（不含文件二进制与密码） */
  private buildDetail(request: Request, action: AuditAction): Record<string, unknown> {
    const detail: Record<string, unknown> = {
      method: request.method,
      path: request.originalUrl ?? request.url,
    };
    const query = request.query as Record<string, unknown>;
    if (query && Object.keys(query).length > 0) {
      detail.query = this.sanitize(query);
    }
    if (action === 'LOGIN' || action === 'LOGOUT') {
      const body = (request.body ?? {}) as Record<string, unknown>;
      detail.username = body.username ?? null;
    } else if (request.body && typeof request.body === 'object') {
      detail.body = this.sanitize(request.body as Record<string, unknown>);
    }
    const ua = request.headers['user-agent'];
    if (typeof ua === 'string') detail.userAgent = ua.slice(0, 200);
    return detail;
  }

  /** 脱敏：去掉密码/令牌/全文长文本，截断超长字段 */
  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const blocked = ['password', 'oldPassword', 'newPassword', 'token', 'accessToken', 'refreshToken', 'fullText', 'content'];
    for (const [k, v] of Object.entries(obj)) {
      if (blocked.includes(k)) {
        out[k] = '***';
        continue;
      }
      if (typeof v === 'string' && v.length > 300) {
        out[k] = `${v.slice(0, 300)}…(${v.length})`;
        continue;
      }
      if (Array.isArray(v) && v.length > 50) {
        out[k] = `[${v.length} 项]`;
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  private isAuditAction(value: string): boolean {
    return [
      'LOGIN', 'LOGOUT', 'CREATE', 'UPDATE', 'DELETE', 'SEARCH', 'PREVIEW', 'DOWNLOAD',
      'APPROVE', 'EXPORT', 'PERM_CHANGE', 'RESTORE', 'VOID', 'BACKUP', 'IMPORT',
    ].includes(value);
  }

  /** 异步落库，失败不影响业务 */
  private write(input: {
    request: Request;
    user: AuthenticatedUser | undefined;
    action: AuditAction;
    objectType: string;
    objectId: string | null;
    result: AuditResult;
    durationMs: number;
    detail: Record<string, unknown>;
  }): void {
    const ip = this.clientIp(input.request);
    void this.auditLogService
      .append({
        userId: input.user?.userId ?? null,
        username: input.user?.username ?? null,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        result: input.result,
        ip,
        durationMs: input.durationMs,
        detail: input.detail,
      })
      .catch((err: unknown) => {
        this.logger.error(`审计日志写入失败: ${(err as Error)?.message ?? String(err)}`);
      });
  }

  private clientIp(request: Request): string | null {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    const ip = request.ip ?? request.socket?.remoteAddress ?? null;
    if (!ip) return null;
    // 去掉 IPv6 映射前缀，便于 inet 存储
    return ip.replace(/^::ffff:/, '');
  }
}
