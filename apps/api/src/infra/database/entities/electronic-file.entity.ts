import { Column, Entity, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn } from 'typeorm';
import { ExtractStatus } from '@tianji/shared';
import { ArchiveItem } from './archive-item.entity';

/**
 * 电子文件 F-08（DA/T 58-2014 / GB/T 18894-2016 四性检测）
 * sha256 为完整性基线，入库必记（PRD 合规底线③）。
 */
@Entity('electronic_file')
@Index('uk_file_bucket_key', ['bucket', 'objectKey'], { unique: true })
@Index('idx_file_item', ['itemId'])
@Index('idx_file_sha', ['sha256'])
export class ElectronicFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ type: 'varchar', length: 64 })
  bucket!: string;

  @Column({ name: 'object_key', type: 'varchar', length: 500 })
  objectKey!: string;

  @Column({ type: 'varchar', length: 300 })
  filename!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  mime!: string | null;

  @Column({ type: 'bigint' })
  size!: string;

  /** SHA-256（64 位十六进制），完整性校验基线 */
  @Column({ type: 'char', length: 64 })
  sha256!: string;

  /** 预览 PDF 的 objectKey（Office 转换结果），位于 archive-preview 桶 */
  @Column({ name: 'preview_key', type: 'varchar', length: 500, nullable: true })
  previewKey!: string | null;

  /** 缩略图 objectKey，位于 archive-thumb 桶 */
  @Column({ name: 'thumb_key', type: 'varchar', length: 500, nullable: true })
  thumbKey!: string | null;

  @Column({ name: 'extract_status', type: 'varchar', length: 16, default: 'PENDING' })
  extractStatus!: ExtractStatus;

  /** 抽取失败原因 */
  @Column({ name: 'extract_error', type: 'text', nullable: true })
  extractError!: string | null;

  /** 四性检测结果（真实性/可用性/安全性预留，完整性 P0 实现） */
  @Column({ name: 'authenticity_check', type: 'jsonb', nullable: true })
  authenticityCheck!: Record<string, unknown> | null;

  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @ManyToOne(() => ArchiveItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: ArchiveItem;
}
