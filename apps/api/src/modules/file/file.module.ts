import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAME } from '@tianji/shared';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { DocumentText } from '../../infra/database/entities/document-text.entity';
import { DictModule } from '../dict/dict.module';
import { ParamModule } from '../param/param.module';

/**
 * 电子文件模块（F-08）。
 * 依赖：MinioService（StorageModule，@Global）、AccessFilterBuilder（AccessModule，@Global）、
 *      DictService（下载/水印开关）、抽取队列（QueueModule，@Global）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ElectronicFile, ArchiveItem, DocumentText]),
    BullModule.registerQueue({ name: QUEUE_NAME.EXTRACT }),
    DictModule,
    ParamModule,
  ],
  controllers: [FileController],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
