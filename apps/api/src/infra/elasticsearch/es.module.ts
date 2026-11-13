import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArchiveItem } from '../database/entities/archive-item.entity';
import { ElectronicFile } from '../database/entities/electronic-file.entity';
import { EsService } from './es.service';
import { EsIndexerService } from './es-indexer.service';

/**
 * ES 模块装配。
 *
 * EsService（索引读写）与 EsIndexerService（条目 → 索引同步）分文件存放：
 * 两者若与模块定义同处一个文件，会形成「模块 → 索引器 → 模块」的循环 import，
 * 编译后 EsService 在索引器装饰器求值时仍是 undefined，Nest 直接启动失败。
 * 这里只做装配，并通过 re-export 保持既有 import 路径不变。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ArchiveItem, ElectronicFile])],
  providers: [EsService, EsIndexerService],
  exports: [EsService, EsIndexerService],
})
export class EsModule {}

export { EsService } from './es.service';
export * from './es.types';
export { EsIndexerService } from './es-indexer.service';
