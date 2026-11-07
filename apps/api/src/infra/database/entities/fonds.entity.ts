import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { FondsStatus } from '@tianji/shared';
import { OrgNode } from './org-node.entity';

/**
 * 全宗 F-01（DA/T 22-2015 §5.2）
 * 全宗号全局唯一；停用（DISABLED）后不可新增档案但可检索。
 */
@Entity('fonds')
export class Fonds {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_fonds_no', { unique: true })
  @Column({ name: 'fonds_no', type: 'varchar', length: 32 })
  fondsNo!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'org_name', type: 'varchar', length: 200, nullable: true })
  orgName!: string | null;

  @Column({ name: 'year_start', type: 'int', nullable: true })
  yearStart!: number | null;

  @Column({ name: 'year_end', type: 'int', nullable: true })
  yearEnd!: number | null;

  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status!: FondsStatus;

  @Column({ name: 'history_note', type: 'text', nullable: true })
  historyNote!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @OneToMany(() => OrgNode, (org) => org.fonds)
  orgs!: OrgNode[];
}
