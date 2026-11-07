import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 全文文本（抽取产物，供全文索引与后续向量化复用 —— RAG 预留）
 */
@Entity('document_text')
@Index('idx_doctext_item', ['itemId'])
@Index('uk_doctext_file_version', ['fileId', 'version'], { unique: true })
export class DocumentText {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ name: 'file_id', type: 'uuid', nullable: true })
  fileId!: string | null;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
