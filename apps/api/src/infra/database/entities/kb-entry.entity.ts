import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SecurityLevel } from '@tianji/shared';

/**
 * 知识库条目（P2 RAG 预留，P0 仅建表 + 接口契约）
 * 密级字段用于 RAG 检索前的 AccessFilterBuilder 过滤，避免越权。
 */
@Entity('kb_entry')
@Index('idx_kb_item', ['itemId'])
@Index('idx_kb_level', ['securityLevel'])
export class KbEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ name: 'source_danghao', type: 'varchar', length: 120 })
  sourceDanghao!: string;

  @Column({ name: 'security_level', type: 'varchar', length: 16 })
  securityLevel!: SecurityLevel;

  @Column({ type: 'text' })
  chunk!: string;

  @Column({ type: 'int', default: 1 })
  version!: number;

  /** NONE/PENDING/OK/FAILED */
  @Column({ name: 'embedding_status', type: 'varchar', length: 16, default: 'NONE' })
  embeddingStatus!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
