import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { ApiResponse } from '@tianji/shared';

/**
 * 统一响应包装拦截器：把 Controller 返回值包装为 `{code, data, message}`。
 *
 * 例外：
 *  - 已经是标准信封（含 code/data/message 三键）的返回值不重复包装；
 *  - 流式响应（StreamableFile / Buffer / Readable）原样透传，避免破坏二进制下载；
 *  - 204 无内容时 `data=null`。
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  public intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data: unknown) => {
        if (this.isStreamLike(data)) return data;
        if (this.isEnvelope(data)) return data;

        const message =
          data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
            ? String((data as { message: string }).message)
            : '成功';

        const payload: ApiResponse<unknown> = {
          code: 0,
          data: data === undefined ? null : data,
          message,
          timestamp: new Date().toISOString(),
        };
        return payload;
      }),
    );
  }

  private isEnvelope(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    return 'code' in d && 'data' in d && 'message' in d;
  }

  private isStreamLike(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    if (Buffer.isBuffer(data)) return true;
    const d = data as Record<string, unknown>;
    // StreamableFile 实例
    if (typeof d.getStream === 'function') return true;
    // Node Readable
    if (typeof (d as { pipe?: unknown }).pipe === 'function') return true;
    return false;
  }
}
