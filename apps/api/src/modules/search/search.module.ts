import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { SavedSearch } from '../../infra/database/entities/saved-search.entity';
import { SearchHistory } from '../../infra/database/entities/search-history.entity';

/**
 * 检索模块。依赖全局 AccessFilterBuilder（AccessModule）与 EsService（EsModule）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ArchiveItem, Fonds, ElectronicFile, SavedSearch, SearchHistory]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
