import { DataSource, DataSourceOptions } from 'typeorm';
import { config as loadDotenv } from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ArchiveItem,
  AuditLog,
  BackupRecord,
  BorrowApproval,
  BorrowOrder,
  Category,
  DanghaoRule,
  DanghaoSequence,
  DictItem,
  DocumentText,
  ElectronicFile,
  Fonds,
  KbEntry,
  OrgNode,
  RecycleBin,
  Role,
  SavedSearch,
  SearchHistory,
  SystemParam,
  UserDataScope,
  Volume,
  AppUser,
} from './entities';
import { isAbsolute } from 'node:path';

/**
 * TypeORM DataSource（供 CLI 迁移使用，运行时由 TypeOrmModule 复用同一 options）。
 * 注意：不使用 TypeORM snake_case NamingStrategy，实体已显式声明列名，
 *      便于后续迁移达梦/人大金仓时对照（架构 §1.2 方言隔离要求）。
 */
function resolveEnvFiles(): string[] {
  const roots = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
    path.resolve(__dirname, '../../../..'),
  ];
  const files: string[] = [];
  for (const root of roots) {
    for (const name of ['.env.local', '.env']) {
      const p = path.join(root, name);
      if (fs.existsSync(p) && !files.includes(p)) files.push(p);
    }
  }
  return files;
}

for (const file of resolveEnvFiles()) {
  loadDotenv({ path: file, override: false });
}

/** 迁移目录：编译后位于 dist/infra/database/migrations。
 *  判定依据是 __dirname 是否处于 dist（而非「migrations 目录是否存在」）——
 *  源码树里该目录同样存在但只含 .ts；旧判定在 ts-node 下取 *.js 通配，
 *  匹配 0 个文件，CLI 静默报「No migrations are pending」（联调现场实证，
 *  数据库除 typeorm_migrations 外零表却显示无待执行迁移）。 */
function resolveMigrationGlob(): string {
  const inDist = __dirname.split(path.sep).includes('dist');
  const ext = inDist ? 'js' : 'ts';
  return path.join(__dirname, `migrations/*.${ext}`);
}

export function buildDataSourceOptions(): DataSourceOptions {
  const migrations = resolveMigrationGlob();
  return {
    type: 'postgres',
    host: process.env.POSTGRES_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    username: process.env.POSTGRES_USER ?? 'tianji',
    password: process.env.POSTGRES_PASSWORD ?? 'tianji_pwd_change_me',
    database: process.env.POSTGRES_DB ?? 'tianji_archive',
    entities: [
      Fonds,
      OrgNode,
      Category,
      DanghaoRule,
      DanghaoSequence,
      Volume,
      ArchiveItem,
      ElectronicFile,
      DocumentText,
      BorrowOrder,
      BorrowApproval,
      AppUser,
      Role,
      UserDataScope,
      AuditLog,
      DictItem,
      SystemParam,
      KbEntry,
      RecycleBin,
      SavedSearch,
      SearchHistory,
      BackupRecord,
    ],
    migrations: [migrations],
    migrationsTableName: 'typeorm_migrations',
    // 严禁 synchronize：所有 DDL 必须走迁移，保证可回滚与信创迁移可控
    synchronize: false,
    logging: (process.env.DB_LOGGING ?? 'false') === 'true' ? ['query', 'error'] : ['error'],
    extra: {
      max: Number.parseInt(process.env.DB_POOL_SIZE ?? '20', 10),
      // 时间统一以 UTC 存取，API 输出 ISO 8601
      options: '-c timezone=UTC',
    },
  };
}

/** CLI 迁移入口使用的单例 DataSource。
 *  注意：TypeORM CLI（migration:run 等）要求 data source 文件**只导出一次** DataSource 实例，
 *  named + default 双导出会报「must contain only one export of DataSource instance」（联调现场实证）。
 *  故仅保留 named export，CLI 用 `-d` 引用本文件即可正确解析。 */
export const AppDataSource = new DataSource(buildDataSourceOptions());

/** 判断路径是否为绝对路径（供脚本使用） */
export function ensureAbsolute(p: string): string {
  return isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}
