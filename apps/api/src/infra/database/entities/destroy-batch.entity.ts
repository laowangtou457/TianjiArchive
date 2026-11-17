import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 销毁批次状态：待审核 → 已审核 → 已销毁（可整批还原 → 已还原） */
export type DestroyBatchStatus = 'PENDING' | 'APPROVED' | 'DESTROYED' | 'RESTORED';

/**
 * 销毁批次 P5（建立批次 → 审核 → 执行销毁）。
 * itemIdsJson 保存待销毁的 archive_item.id 列表，执行时逐条软删除并留痕。
 */
@Entity('destroy_batch')
export class DestroyBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_destroy_batch_no', { unique: true })
  @Column({ name: 'batch_no', type: 'varchar', length: 64 })
  batchNo!: string;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status!: DestroyBatchStatus;

  @Column({ name: 'item_ids_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  itemIdsJson!: string[];

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
