import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExtensionRecord } from '../../infra/database/entities/extension-record.entity';
import { AuditModule } from '../audit/audit.module';
import { ExtensionController } from './extension.controller';
import { ExtensionService } from './extension.service';

/**
 * 扩展功能通用模块（P6 门类扩展 / P7 接收移交四性 ERMS / P8 实体与增值）。
 *
 * 需在 AppModule 注册：import { ExtensionModule } from './modules/extension/extension.module';
 * ExtensionRecord 实体还需在 entities/index.ts 导出并加入 typeorm.module.ts 的 ALL_ENTITIES。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ExtensionRecord]), AuditModule],
  controllers: [ExtensionController],
  providers: [ExtensionService],
  exports: [ExtensionService],
})
export class ExtensionModule {}
