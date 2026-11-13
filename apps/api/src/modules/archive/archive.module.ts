import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArchiveService } from './archive.service';
import { ArchiveController } from './archive.controller';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Volume } from '../../infra/database/entities/volume.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { OrgNode } from '../../infra/database/entities/org-node.entity';
import { Category } from '../../infra/database/entities/category.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { ItemStageLog } from '../../infra/database/entities/item-stage-log.entity';
import { DanghaoModule } from '../danghao/danghao.module';
import { FondsModule } from '../fonds/fonds.module';
import { CategoryModule } from '../category/category.module';
import { RecycleModule } from '../recycle/recycle.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ArchiveItem, Volume, Fonds, OrgNode, Category, ElectronicFile, ItemStageLog]),
    DanghaoModule,
    FondsModule,
    CategoryModule,
    RecycleModule,
  ],
  controllers: [ArchiveController],
  providers: [ArchiveService],
  exports: [ArchiveService],
})
export class ArchiveModule {}
