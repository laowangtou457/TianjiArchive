import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import type { AppConfig } from '../../config/configuration';
import { QUEUE_NAME } from '@tianji/shared';

export const QUEUE_TOKEN = {
  EXTRACT: QUEUE_NAME.EXTRACT,
  BACKUP: QUEUE_NAME.BACKUP,
  BULK_IMPORT: QUEUE_NAME.BULK_IMPORT,
} as const;

/**
 * BullMQ 队列注册（API 侧只做生产者；消费者在 apps/extractor 与 backup 模块）。
 * Redis 连接与 RedisModule 保持一致。
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const rc = config.get<AppConfig['redis']>('redis');
        return {
          connection: {
            host: rc?.host ?? '127.0.0.1',
            port: rc?.port ?? 6379,
            password: rc?.password ? rc.password : undefined,
            db: rc?.db ?? 0,
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { age: 86400 * 3, count: 5000 },
            removeOnFail: { age: 86400 * 14 },
          },
        };
      },
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAME.EXTRACT },
      { name: QUEUE_NAME.BACKUP },
      { name: QUEUE_NAME.BULK_IMPORT },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
