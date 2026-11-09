import { Controller, Get, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators/require-perm.decorator';
import { DataSource } from 'typeorm';
import { EsService } from '../../infra/elasticsearch/es.module';
import { MinioService } from '../../infra/storage/storage.module';
import { RedisService } from '../../infra/redis/redis.module';
import type { HealthStatus } from '@tianji/shared';

/**
 * 健康检查（T01 验收要点：/api/health 返回 200）。
 * 汇总 PG / ES / 对象存储 / Redis 依赖状态，任一不健康则 status=degraded（HTTP 仍 200，
 * 由编排层根据 body 判定，避免 ES 抖动导致容器被反复重启）。
 *
 * deps 的键名用中性的 `objectStorage`：后端实现已从 MinIO 换为
 * SeaweedFS S3 Gateway（方案 A），键名若写死 minio 会让前端/报告产生误读。
 */
@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly dataSource: DataSource,
    private readonly es: EsService,
    private readonly minio: MinioService,
    private readonly redis: RedisService,
  ) {}

  public async check(): Promise<HealthStatus> {
    const deps: HealthStatus['deps'] = [];

    const dbStart = Date.now();
    let dbOk = false;
    try {
      dbOk = this.dataSource.isInitialized;
      if (dbOk) await this.dataSource.query('SELECT 1');
    } catch {
      dbOk = false;
    }
    deps.push({ name: 'postgres', ok: dbOk, latencyMs: Date.now() - dbStart });

    const esStart = Date.now();
    const esOk = await this.es.ping();
    deps.push({ name: 'elasticsearch', ok: esOk, latencyMs: Date.now() - esStart });

    const storageStart = Date.now();
    const storageOk = await this.minio.ping();
    deps.push({ name: 'objectStorage', ok: storageOk, latencyMs: Date.now() - storageStart });

    const redisStart = Date.now();
    const redisOk = await this.redis.ping();
    deps.push({ name: 'redis', ok: redisOk, latencyMs: Date.now() - redisStart });

    const allOk = deps.every((d) => d.ok);
    return {
      status: allOk ? 'ok' : 'degraded',
      version: '1.0.0',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      deps,
    };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** 健康检查：无需认证 */
  @Public()
  @Get()
  public async check(): Promise<HealthStatus> {
    return this.healthService.check();
  }

  /** 就绪检查：数据库不可用时返回 503（供 K8s/Compose readiness） */
  @Public()
  @Get('ready')
  public async ready(): Promise<{ ready: boolean }> {
    const status = await this.healthService.check();
    const db = status.deps.find((d) => d.name === 'postgres');
    if (!db?.ok) throw new ServiceUnavailableException('数据库不可用');
    return { ready: true };
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
