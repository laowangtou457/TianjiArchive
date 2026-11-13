import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { SynonymService } from './synonym.service';
import { SearchController } from './search.controller';
import { ArchiveItem } from '../../infra/database/entities/archive-item.entity';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { ElectronicFile } from '../../infra/database/entities/electronic-file.entity';
import { SavedSearch } from '../../infra/database/entities/saved-search.entity';
import { SearchHistory } from '../../infra/database/entities/search-history.entity';
import { SearchSynonym } from '../../infra/database/entities/search-synonym.entity';

/**
 * 检索模块。依赖全局 AccessFilterBuilder（AccessModule）、EsService/EsIndexerService（EsModule）
 * 与 RedisService（RedisModule）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ArchiveItem,
      Fonds,
      ElectronicFile,
      SavedSearch,
      SearchHistory,
      SearchSynonym,
    ]),
  ],
  controllers: [SearchController],
  providers: [SearchService, SynonymService],
  exports: [SearchService, SynonymService],
})
export class SearchModule {}
