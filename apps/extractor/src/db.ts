import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * 打开数据库连接（抽取器只用原始 SQL，不加载实体元数据）。
 * 复用与 API 相同的环境变量，保证同库同 schema。
 */
export async function openDatabase(): Promise<DataSource> {
  const logger = new Logger('ExtractorDB');
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER ?? 'tianji',
    password: process.env.POSTGRES_PASSWORD ?? '',
    database: process.env.POSTGRES_DB ?? 'tianji_archive',
    // 抽取器不管理 schema，也不需要实体
    entities: [],
    synchronize: false,
    migrationsRun: false,
    logging: false,
    extra: { max: 4, options: '-c timezone=UTC' },
  });
  await ds.initialize();
  logger.log(`已连接 ${process.env.POSTGRES_DB ?? 'tianji_archive'}`);
  return ds;
}
