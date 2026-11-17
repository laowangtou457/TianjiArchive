import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 销毁明细/留痕 P5。
 * result 取值：PENDING（待销毁）/ DESTROYED（已销毁）/ NOT_FOUND（档号未匹配）/ FAILED（执行失败）。
 */
@Entity('destroy_entry')
@Index('idx_destroy_entry_batch', ['batchId'])
export class DestroyEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  /** 关联条目；档号未匹配时为空 */
  @Column({ name: 'item_id', type: 'uuid', nullable: true })
  itemId!: string | null;

  @Column({ type: 'varchar', length: 120 })
  danghao!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  title!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'PENDING' })
  result!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
