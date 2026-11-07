import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  BizException,
  ErrorCode,
  findErrorDef,
  type ApiResponse,
} from '@tianji/shared';
import { randomUUID } from 'node:crypto';

/**
 * 全局异常过滤器：统一输出 `{code, data, message, traceId, timestamp}`（架构 §11）。
 *
 * 映射规则：
 *  - BizException         → 业务码 + 建议 HTTP 状态
 *  - HttpException        → 按 HTTP 状态反查业务码（401/403/404/400/409）
 *  - PG 唯一约束冲突 23505 → 409 + 业务码（可被 BizException 提前覆盖）
 *  - 其它异常             → 500 INTERNAL_ERROR，日志记录堆栈，不向客户端泄漏细节
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method?: string; url?: string; headers?: Record<string, unknown> }>();
    const traceId = randomUUID();

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = ErrorCode.INTERNAL_ERROR.code;
    let message: string = ErrorCode.INTERNAL_ERROR.message;
    let details: unknown = null;

    if (exception instanceof BizException) {
      httpStatus = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        const rawMessage = p.message;
        if (Array.isArray(rawMessage)) {
          message = rawMessage.join('；');
          details = rawMessage;
        } else if (typeof rawMessage === 'string') {
          message = rawMessage;
        } else {
          message = exception.message;
        }
        if (typeof p.code === 'number') code = p.code;
      }
      if (code === ErrorCode.INTERNAL_ERROR.code) {
        code = this.codeFromHttpStatus(httpStatus);
      }
    } else if (this.isPgUniqueViolation(exception)) {
      httpStatus = HttpStatus.CONFLICT;
      code = ErrorCode.ARCHIVE_NO_CONFLICT.code;
      message = '数据唯一性冲突（档号或唯一键重复），请重试或更换取值';
      details = (exception as { detail?: string }).detail ?? null;
    } else if (exception instanceof Error) {
      message = ErrorCode.INTERNAL_ERROR.message;
      this.logger.error(
        `[${traceId}] ${request.method ?? ''} ${request.url ?? ''} 未捕获异常: ${exception.message}`,
        exception.stack,
      );
    }

    // 5xx 才记录 error 级别，避免日志噪声
    if (httpStatus >= 500 && !(exception instanceof BizException)) {
      this.logger.error(
        `[${traceId}] ${request.method ?? ''} ${request.url ?? ''} -> ${httpStatus}`,
      );
    } else if (httpStatus === 403 || httpStatus === 401) {
      this.logger.warn(
        `[${traceId}] ${request.method ?? ''} ${request.url ?? ''} -> ${httpStatus} ${message}`,
      );
    }

    const body: ApiResponse<null> & { detail?: unknown } = {
      code,
      data: null,
      message,
      traceId,
      timestamp: new Date().toISOString(),
    };
    if (details !== null && details !== undefined) body.detail = details;

    response.status(httpStatus).json(body);
  }

  /** HTTP 状态 → 业务码反查 */
  private codeFromHttpStatus(status: number): number {
    const map: Record<number, number> = {
      400: ErrorCode.BAD_REQUEST.code,
      401: ErrorCode.UNAUTHORIZED.code,
      403: ErrorCode.FORBIDDEN.code,
      404: ErrorCode.NOT_FOUND.code,
      409: ErrorCode.CONFLICT.code,
      413: ErrorCode.FILE_TOO_LARGE.code,
      415: ErrorCode.FILE_UNSUPPORTED_TYPE.code,
      423: ErrorCode.ACCOUNT_LOCKED.code,
      429: ErrorCode.TOO_MANY_REQUESTS.code,
      501: ErrorCode.NOT_IMPLEMENTED.code,
      503: ErrorCode.DEPENDENCY_UNAVAILABLE.code,
    };
    return map[status] ?? findErrorDef(ErrorCode.INTERNAL_ERROR.code)?.code ?? 5000;
  }

  /** 判断是否为 PostgreSQL 唯一约束冲突 */
  private isPgUniqueViolation(exception: unknown): boolean {
    if (!exception || typeof exception !== 'object') return false;
    const e = exception as { code?: string; driverError?: { code?: string } };
    return e.code === '23505' || e.driverError?.code === '23505';
  }
}
