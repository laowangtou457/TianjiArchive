import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogService } from './audit-log.service';
import { AuditController } from './audit.controller';
import { AuditLog } from '../../infra/database/entities/audit-log.entity';

/**
 * 审计模块。AuditLogService 需被全局拦截器注入，故导出并在 AppModule 中可用。
 * 注意：AuditLogInterceptor 在 AppModule 以 APP_INTERCEPTOR 注册，依赖本模块导出的 service，
 * 因此本模块须为 @Global() 或 AppModule 直接 import（此处两者兼顾）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [AuditController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditModule {}
