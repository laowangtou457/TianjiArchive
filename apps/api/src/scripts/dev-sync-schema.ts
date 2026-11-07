/**
 * 开发环境 schema 同步（仅供本地开发，生产禁止使用）。
 *
 * 用法：pnpm --filter @tianji/api schema:sync
 *
 * 用途：本地快速迭代实体时同步表结构；正式环境必须用迁移（migration:run）。
 * 保护：NODE_ENV=production 时直接拒绝执行。
 */
import { AppDataSource } from '../infra/database/data-source';

async function main(): Promise<void> {
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    throw new Error('生产环境禁止 synchronize，请使用 migration:run');
  }
  await AppDataSource.initialize();
  try {
    console.warn('⚠ 正在同步实体到数据库（仅开发环境）…');
    await AppDataSource.synchronize();
    console.log('✔ schema 同步完成');
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err: Error) => {
  console.error(`✖ 同步失败：${err.message}`);
  process.exit(1);
});
