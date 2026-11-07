import { Global, Module, OnModuleDestroy, Logger, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppConfig } from '../../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Redis 客户端封装（缓存 / 会话吊销表 / 登录失败计数）。
 * 提供 get/set/del/delByPrefix/incr 等便捷方法，屏蔽 ioredis 细节。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly client: Redis) {}

  /** 原始客户端（BullMQ 等需要直接使用） */
  public get raw(): Redis {
    return this.client;
  }

  public async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`Redis GET 失败 key=${key}: ${(err as Error).message}`);
      return null;
    }
  }

  public async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch (err) {
      this.logger.warn(`Redis SET 失败 key=${key}: ${(err as Error).message}`);
    }
  }

  public async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  public async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(`Redis DEL 失败: ${(err as Error).message}`);
    }
  }

  /** 按前缀批量失效（SCAN 实现，避免阻塞） */
  public async delByPrefix(prefix: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    try {
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          await this.client.del(...keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(`Redis SCAN 清理失败 prefix=${prefix}: ${(err as Error).message}`);
    }
    return removed;
  }

  /** 自增并设置过期（登录失败计数） */
  public async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    try {
      const value = await this.client.incr(key);
      if (value === 1) await this.client.expire(key, ttlSeconds);
      return value;
    } catch (err) {
      this.logger.warn(`Redis INCR 失败 key=${key}: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * 自增（不设 TTL 之外的副作用，供版本号使用）。
   * 失败时抛错——版本号拿不到就不能保证权限即时生效，必须让上层感知。
   */
  public async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  /** 读取计数（不存在返回 0） */
  public async getCounter(key: string): Promise<number> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return 0;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    } catch (err) {
      this.logger.warn(`Redis GET 计数失败 key=${key}: ${(err as Error).message}`);
      return 0;
    }
  }

  /** 设置过期（用于给计数键续期） */
  public async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.expire(key, ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis EXPIRE 失败 key=${key}: ${(err as Error).message}`);
    }
  }

  /**
   * 发布消息（跨实例广播）。
   * 失败只告警不抛：广播丢包时各实例的 TTL 兜底仍能收敛，
   * 但版本号方案下「读不到新版本」本身就是安全的（旧 key 直接读不到）。
   */
  public async publish(channel: string, message: string): Promise<void> {
    try {
      await this.client.publish(channel, message);
    } catch (err) {
      this.logger.warn(`Redis PUBLISH 失败 channel=${channel}: ${(err as Error).message}`);
    }
  }

  /**
   * 创建一条独立的订阅连接。
   *
   * 原因：ioredis 进入 subscribe 模式后该连接不能再执行普通命令，
   * 必须复制一个专用连接，否则会把主连接的 GET/SET 全部阻塞。
   */
  public duplicateForSubscribe(): Redis {
    return this.client.duplicate();
  }

  /** 健康检查 */
  public async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  public async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      /* 退出期忽略 */
    }
  }
}

/** 缓存的键值 getOrLoad 装饰器（薄封装） */
export async function cached<T>(
  redis: RedisService,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await redis.getJson<T>(key);
  if (hit !== null) return hit;
  const value = await loader();
  await redis.setJson(key, value, ttlSeconds);
  return value;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const rc = config.get<AppConfig['redis']>('redis');
        return new Redis({
          host: rc?.host ?? '127.0.0.1',
          port: rc?.port ?? 6379,
          password: rc?.password ? rc.password : undefined,
          db: rc?.db ?? 0,
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
          retryStrategy: (times: number): number => Math.min(times * 200, 3000),
        });
      },
    },
    {
      provide: RedisService,
      inject: [REDIS_CLIENT],
      useFactory: (client: Redis): RedisService => new RedisService(client),
    },
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
