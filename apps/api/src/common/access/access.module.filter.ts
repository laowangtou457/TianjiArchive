import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';

/**
 * 越权访问统一出口：403 + 中文原因，便于前端直接提示。
 * 通常由 HttpExceptionFilter 处理；此过滤器用于需要单独挂载的场景（如文件流接口）。
 */
@Catch()
export class AccessDeniedEchoFilter implements ExceptionFilter {
  private readonly logger = new Logger(AccessDeniedEchoFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const res = host
      .switchToHttp()
      .getResponse<{ status: (c: number) => { json: (b: unknown) => void } }>();
    this.logger.warn(`访问被拒绝: ${(exception as Error)?.message ?? ''}`);
    res.status(403).json({ code: 1003, data: null, message: '无权限访问该资源' });
  }
}
