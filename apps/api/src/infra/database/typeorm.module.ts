import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfig } from '../../config/configuration';
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
  ItemStageLog,
  KbEntry,
  OrgNode,
  RecycleBin,
  Role,
  SavedSearch,
  SearchHistory,
  SearchSynonym,
  SystemParam,
  UserDataScope,
  Volume,
  AppUser,
} from './entities';

/** 全量实体清单（供各模块 import） */
export const ALL_ENTITIES = [
  Fonds,
  OrgNode,
  Category,
  DanghaoRule,
  DanghaoSequence,
  Volume,
  ArchiveItem,
  ItemStageLog,
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
  SearchSynonym,
  BackupRecord,
] as const;

/**
 * 数据库根模块（全局）。
 * synchronize 关闭 —— 表结构全部由 migration 管理（架构 §4.2）。
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const db = config.get<AppConfig['db']>('db');
        return {
          type: 'postgres' as const,
          host: db?.host ?? '127.0.0.1',
          port: db?.port ?? 5432,
          username: db?.username ?? 'tianji',
          password: db?.password ?? '',
          database: db?.database ?? 'tianji_archive',
          entities: [...ALL_ENTITIES],
          synchronize: false,
          logging: db?.logging ? (['query', 'error'] as const) : (['error'] as const),
          extra: {
            max: db?.poolSize ?? 20,
            options: '-c timezone=UTC',
          },
          // 单实例启动时自动执行未跑过的迁移；多实例可用环境变量关闭，改由部署脚本执行
          migrationsRun: (process.env.DB_MIGRATIONS_RUN ?? 'true') === 'true',
          migrations: [],
          migrationsTableName: 'typeorm_migrations',
        };
      },
    }),
    TypeOrmModule.forFeature([...ALL_ENTITIES]),
  ],
  exports: [TypeOrmModule],
})
export class TypeOrmRootModule {}
