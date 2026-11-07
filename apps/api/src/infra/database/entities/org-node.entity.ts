import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Fonds } from './fonds.entity';

/**
 * 组织机构树（全宗下可维护，架构 §4.1 OrgNode）
 */
@Entity('org_node')
@Index('idx_org_fonds', ['fondsId'])
@Index('idx_org_parent', ['parentId'])
@Index('uk_org_fonds_code', ['fondsId', 'code'], { unique: true })
export class OrgNode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'fonds_id', type: 'uuid' })
  fondsId!: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'int', default: 0 })
  sort!: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @ManyToOne(() => Fonds, (f) => f.orgs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'fonds_id' })
  fonds!: Fonds;

  /** 运行时挂载的子节点（非数据库列） */
  children?: OrgNode[];
}
