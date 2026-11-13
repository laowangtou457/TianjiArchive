import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 条目关联（P4 LLM Wiki：档案知识组织）。
 *
 * relation_type 语义（先固定这几类，够用且可解释）：
 *   RELATED   主题相关（同主题词/同分类，自动生成）
 *   SERIES    同一案卷/同系列（自动生成）
 *   CITES     引用（人工建立）
 *   SAME_DOC  同一文件的不同版本/载体（人工建立）
 *
 * 自动关联写入 source='AUTO'，可被人工删除；人工关联 source='MANUAL'，重建不清除。
 */
@Entity('item_relation')
@Index('uk_item_relation', ['sourceItemId', 'targetItemId', 'relationType'], { unique: true })
@Index('idx_item_relation_source', ['sourceItemId'])
export class ItemRelation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'source_item_id', type: 'uuid' })
  sourceItemId!: string;

  @Column({ name: 'target_item_id', type: 'uuid' })
  targetItemId!: string;

  @Column({ name: 'relation_type', type: 'varchar', length: 20, default: 'RELATED' })
  relationType!: string;

  /** 关联强度 0-1（自动关联按主题词重合度算） */
  @Column({ type: 'double precision', default: 0.5 })
  weight!: number;

  @Column({ type: 'varchar', length: 10, default: 'AUTO' })
  source!: 'AUTO' | 'MANUAL';

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
