import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Logger } from '@nestjs/common';
import { QUEUE_NAME, type ExtractJobPayload } from '@tianji/shared';
import { openDatabase } from './db';
import type { ExtractorContext } from './context';
import { EsIndexer } from './es.indexer';
import { ObjectFetcher } from './object.fetcher';
import { ExtractProcessor } from './extract.processor';

/**
 * 文本抽取 Worker 入口（独立进程，架构 §6.3）。
 *
 * 职责：
 *   1) 消费 BullMQ `archive-extract` 队列（并发 ≤ 4，NFR-6）；
 *   2) 从 MinIO 拉取原件 → 按 MIME 路由转换器 → 抽文本/缩略图/Office→PDF；
 *   3) 写 document_text、更新 electronic_file（previewKey/thumbKey/extractStatus）；
 *   4) 同步更新 ES 的 fulltext 字段（全文检索可命中正文）。
 *
 * 设计约束：
 *   - 不启动 HTTP 服务（无端口，只做后台消费）；
 *   - 失败重试 3 次（指数退避，由队列 defaultJobOptions 控制）；
 *   - 抽取失败不阻塞业务，仅置 extractStatus=FAILED 并在接口侧提示。
 */
const logger = new Logger('ExtractorMain');

/** 并发上限（libreoffice 转换吃 CPU，超过 4 会互相拖慢） */
const CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.EXTRACT_CONCURRENCY ?? 4)));

/** Redis 连接（BullMQ 需要 maxRetriesPerRequest=null） */
function buildRedis(): IORedis {
  const host = process.env.REDIS_HOST ?? '127.0.0.1';
  const port = Number(process.env.REDIS_PORT ?? 6379);
  const password = process.env.REDIS_PASSWORD || undefined;
  const db = Number(process.env.REDIS_DB ?? 0);
  return new IORedis({ host, port, password, db, maxRetriesPerRequest: null });
}

/** 入口 */
async function bootstrap(): Promise<void> {
  logger.log(`抽取 Worker 启动：并发=${CONCURRENCY}，队列=${QUEUE_NAME.EXTRACT}`);

  const dataSource = await openDatabase();
  logger.log('数据库连接成功');

  const redis = buildRedis();
  const fetcher = new ObjectFetcher();
  const indexer = new EsIndexer();
  const processor = new ExtractProcessor(dataSource, fetcher, indexer);

  const context: ExtractorContext = { dataSource, redis, fetcher, indexer, processor };

  const worker = new Worker<ExtractJobPayload>(
    QUEUE_NAME.EXTRACT,
    async (job) => {
      const payload = job.data;
      logger.log(`处理抽取任务 ${job.id}：${payload.filename}（${payload.mime}）`);
      const started = Date.now();
      const result = await processor.process(payload);
      logger.log(
        `抽取完成 ${payload.filename}：状态=${result.status}，字符数=${result.charCount}，耗时=${Date.now() - started}ms`,
      );
      return result;
    },
    {
      connection: redis,
      concurrency: CONCURRENCY,
      limiter: { max: 20, duration: 1000 },
    },
  );

  const queueEvents = new QueueEvents(QUEUE_NAME.EXTRACT, { connection: buildRedis() });
  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error(`任务失败 ${jobId}: ${failedReason}`);
  });

  worker.on('error', (err) => logger.error(`Worker 错误: ${err.message}`));
  worker.on('completed', (job) => logger.debug(`任务完成 ${job.id}`));

  /** 定时清理（每天凌晨 3 点，避免队列无限堆积） */
  const cleanupQueue = new Queue(QUEUE_NAME.EXTRACT, { connection: buildRedis() });
  const cleanupTimer = setInterval(
    () => {
      void cleanupQueue
        .clean(86400000, 5000, 'completed')
        .then((removed) => {
          if (removed.length > 0) logger.debug(`清理已完成任务 ${removed.length} 个`);
        })
        .catch((err: Error) => logger.warn(`队列清理失败: ${err.message}`));
    },
    6 * 3600 * 1000,
  );

  /** 优雅退出 */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`收到 ${signal}，正在优雅退出…`);
    clearInterval(cleanupTimer);
    await worker.close();
    await queueEvents.close();
    await cleanupQueue.close();
    await redis.quit();
    await dataSource.destroy();
    logger.log('抽取 Worker 已退出');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝: ${String(reason)}`);
  });

  logger.log(`抽取 Worker 就绪，等待任务（pid=${process.pid}）`);
  // 保持进程存活
  void context;
}

void bootstrap().catch((err: Error) => {
  logger.error(`抽取 Worker 启动失败: ${err.message}\n${err.stack ?? ''}`);
  process.exit(1);
});
