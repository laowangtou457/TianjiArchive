import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import type { AppConfig } from './config/configuration';
import { validateProductionConfig } from './config/configuration';

/**
 * API 进程入口。
 * 启动次序：helmet → CORS 白名单 → 全局校验管道 → 全局过滤器 → 全局响应包装 → 前缀 /api。
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    rawBody: false,
  });

  const config = app.get(ConfigService);
  const appConfig = config.get<AppConfig['api']>('api');
  const features = config.get<AppConfig['features']>('features');
  const fullConfig = {
    env: config.get<string>('env') ?? 'development',
    api: appConfig,
    jwt: config.get<AppConfig['jwt']>('jwt'),
    db: config.get<AppConfig['db']>('db'),
    minio: config.get<AppConfig['minio']>('minio'),
    features,
  } as AppConfig;

  // ------------------------------------------------------------------ 安全头
  app.use(
    helmet({
      contentSecurityPolicy: false, // 由 Nginx 统一下发 CSP
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ------------------------------------------------------------------ CORS 白名单
  app.enableCors({
    origin: appConfig?.corsOrigins ?? [],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    maxAge: 600,
  });

  // ------------------------------------------------------------------ 全局校验
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  // ------------------------------------------------------------------ 响应统一包装 + 异常统一出口
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  // ------------------------------------------------------------------ 路由前缀
  app.setGlobalPrefix(appConfig?.prefix ?? 'api');

  // 优雅退出（K8s/Compose 停止时等待在途请求）
  app.enableShutdownHooks();

  const port = appConfig?.port ?? 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`天玑档案 API 已启动: http://0.0.0.0:${port}/${appConfig?.prefix ?? 'api'}`);
  logger.log(`运行环境: ${fullConfig.env}｜下载开关: ${features?.downloadEnabled ? '开' : '关'}｜预览水印: ${features?.previewWatermark ? '开' : '关'}`);

  const warnings = validateProductionConfig(fullConfig);
  warnings.forEach((w) => logger.warn(`[配置告警] ${w}`));
}

bootstrap().catch((err: unknown) => {
  // 启动失败必须可见，禁止静默退出
  // eslint-disable-next-line no-console
  console.error('[Bootstrap] 启动失败:', err);
  process.exit(1);
});
