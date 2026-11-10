import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SecurityLevel } from '@tianji/shared';

/**
 * 知识库片段（A 档检索增强的权威存储；ES `kb_chunks` 是其检索镜像）
 * 密级字段用于 RAG 检索前的 AccessFilterBuilder 过滤，避免越权。
 */
@Entity('kb_entry')
@Index('idx_kb_item', ['itemId'])
@Index('idx_kb_level', ['securityLevel'])
@Index('uk_kb_item_chunk', ['itemId', 'chunkNo'], { unique: true })
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

  /** 片段在原文中的序号（自 0 起），与 item_id 组成唯一键，保证重建幂等 */
  @Column({ name: 'chunk_no', type: 'int', default: 0 })
  chunkNo!: number;

  @Column({ type: 'int', default: 1 })
  version!: number;

  /** NONE/PENDING/OK/FAILED */
  @Column({ name: 'embedding_status', type: 'varchar', length: 16, default: 'NONE' })
  embeddingStatus!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
