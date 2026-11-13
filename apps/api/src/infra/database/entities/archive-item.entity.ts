import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ItemStatus, OpenFlag, Retention, SecurityLevel } from '@tianji/shared';
import { Volume } from './volume.entity';

/**
 * 件级档案 F-04（DA/T 22-2015 §6 件级整理；DA/T 18-2022 §7 著录项目）
 *
 * 核心著录字段（PRD 表 F-03-1，不可裁剪）：
 *   档号、题名、责任者、形成日期、年度、保管期限、密级、页数/件数
 * 检索点（DA/T 18-2022 §8）：题名、责任者、主题词、分类号、文号、日期、全文。
 */
@Entity('archive_item')
@Index('idx_item_query', ['fondsId', 'year', 'retention', 'securityLevel', 'categoryCode'], {
  where: 'deleted = FALSE',
})
@Index('idx_item_date', ['docDate'])
@Index('idx_item_volume', ['volumeId'])
@Index('idx_item_status', ['status', 'deleted'])
export class ArchiveItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'volume_id', type: 'uuid', nullable: true })
  volumeId!: string | null;

  @Column({ name: 'fonds_id', type: 'uuid' })
  fondsId!: string;

  /** 档号：全库唯一，入库不可改 */
  @Index('uk_item_danghao', { unique: true })
  @Column({ type: 'varchar', length: 120 })
  danghao!: string;

  // -------------------------------------------------------------- 核心著录字段
  @Column({ type: 'varchar', length: 500 })
  title!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  responsible!: string | null;

  @Column({ name: 'doc_no', type: 'varchar', length: 120, nullable: true })
  docNo!: string | null;

  @Column({ name: 'doc_date', type: 'date', nullable: true })
  docDate!: string | null;

  @Column({ type: 'int' })
  year!: number;

  @Column({ type: 'varchar', length: 16 })
  retention!: Retention;

  @Index('idx_item_level')
  @Column({ name: 'security_level', type: 'varchar', length: 16, default: 'PUBLIC' })
  securityLevel!: SecurityLevel;

  @Column({ name: 'category_code', type: 'varchar', length: 32, nullable: true })
  categoryCode!: string | null;

  @Column({ name: 'class_no', type: 'varchar', length: 64, nullable: true })
  classNo!: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  keywords!: string[];

  @Column({ type: 'int', nullable: true })
  pages!: number | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // -------------------------------------------------------------- 状态与开放
  @Column({ type: 'varchar', length: 16, default: 'DRAFT' })
  status!: ItemStatus;

  /** 归档人（确认归档时写入；泰坦 GDUSER 同位） */
  @Column({ name: 'archived_by', type: 'uuid', nullable: true })
  archivedBy!: string | null;

  /** 归档时间（确认归档时写入；泰坦 GDTIME 同位） */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  @Column({ name: 'open_flag', type: 'varchar', length: 16, default: 'CONTROLLED' })
  openFlag!: OpenFlag;

  /** 全文文本（由 extractor 抽取写入，可人工编辑） */
  @Column({ name: 'full_text', type: 'text', nullable: true })
  fullText!: string | null;

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

  @ManyToOne(() => Volume, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'volume_id' })
  volume!: Volume | null;
}
