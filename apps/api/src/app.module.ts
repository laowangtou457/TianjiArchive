import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { loadConfiguration } from './config/configuration';
import { TypeOrmRootModule } from './infra/database/typeorm.module';
import { EsModule } from './infra/elasticsearch/es.module';
import { StorageModule } from './infra/storage/storage.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { DictModule } from './modules/dict/dict.module';
import { ParamModule } from './modules/param/param.module';
import { AuditModule } from './modules/audit/audit.module';
import { FondsModule } from './modules/fonds/fonds.module';
import { CategoryModule } from './modules/category/category.module';
import { DanghaoModule } from './modules/danghao/danghao.module';
import { ArchiveModule } from './modules/archive/archive.module';
import { SearchModule } from './modules/search/search.module';
import { FileModule } from './modules/file/file.module';
import { BorrowModule } from './modules/borrow/borrow.module';
import { ReportModule } from './modules/report/report.module';
import { BackupModule } from './modules/backup/backup.module';
import { KbModule } from './modules/kb/kb.module';
import { RecycleModule } from './modules/recycle/recycle.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionGuard } from './common/guards/permission.guard';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';

/**
 * 根模块。
 * 全局守卫次序：JwtAuthGuard（认证）→ PermissionGuard（四要素授权）。
 * 全局拦截器：AuditLogInterceptor 全量留痕（SEARCH/PREVIEW/DOWNLOAD 强制）。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env', '../../.env'],
      load: [loadConfiguration],
    }),
    ScheduleModule.forRoot(),
    TypeOrmRootModule,
    RedisModule,
    EsModule,
    StorageModule,
    QueueModule,
    HealthModule,
    AuthModule,
    UserModule,
    ParamModule,
    DictModule,
    AuditModule,
    FondsModule,
    CategoryModule,
    DanghaoModule,
    ArchiveModule,
    SearchModule,
    FileModule,
    BorrowModule,
    ReportModule,
    BackupModule,
    KbModule,
    RecycleModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
