import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Retention, SecurityLevel, VolumeStatus } from '@tianji/shared';
import { Fonds } from './fonds.entity';

/**
 * 案卷 F-03（DA/T 18-2022 §7 著录项目）
 * 档号入库后不可改（应用层禁止 UPDATE danghao，仅作废重编）。
 */
@Entity('volume')
@Index('idx_volume_fonds_year', ['fondsId', 'year', 'deleted'])
@Index('idx_volume_query', ['fondsId', 'year', 'retention', 'securityLevel'])
export class Volume {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'fonds_id', type: 'uuid' })
  fondsId!: string;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId!: string | null;

  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  /** 档号：全库唯一，入库不可改 */
  @Index('uk_volume_danghao', { unique: true })
  @Column({ type: 'varchar', length: 120 })
  danghao!: string;

  @Column({ type: 'varchar', length: 500 })
  title!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  responsible!: string | null;

  @Column({ type: 'int' })
  year!: number;

  @Column({ type: 'varchar', length: 16 })
  retention!: Retention;

  @Index('idx_volume_level')
  @Column({ name: 'security_level', type: 'varchar', length: 16, default: 'PUBLIC' })
  securityLevel!: SecurityLevel;

  @Column({ name: 'item_count', type: 'int', default: 0 })
  itemCount!: number;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate!: string | null;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate!: string | null;

  @Column({ name: 'class_no', type: 'varchar', length: 64, nullable: true })
  classNo!: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  keywords!: string[];

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'DRAFT' })
  status!: VolumeStatus;

  /** 动态扩展字段（门类 field_schema 定义的非固定列） */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  extra!: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  deleted!: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Fonds, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'fonds_id' })
  fonds!: Fonds;
}
