import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FondsService } from './fonds.service';
import { FondsController } from './fonds.controller';
import { Fonds } from '../../infra/database/entities/fonds.entity';
import { OrgNode } from '../../infra/database/entities/org-node.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Fonds, OrgNode])],
  controllers: [FondsController],
  providers: [FondsService],
  exports: [FondsService],
})
export class FondsModule {}
