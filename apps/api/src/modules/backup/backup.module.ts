import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAME } from '@tianji/shared';
import { BackupRecord } from '../../infra/database/entities/backup-record.entity';
import { AuditModule } from '../audit/audit.module';
import { ParamModule } from '../param/param.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/** 备份模块（F-11） */
@Module({
  imports: [
    TypeOrmModule.forFeature([BackupRecord]),
    BullModule.registerQueue({ name: QUEUE_NAME.BACKUP }),
    AuditModule,
    // BackupService 注入 ParamService（备份保留天数等参数），必须显式 import
    ParamModule,
  ],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
