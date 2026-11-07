import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { RecycleObjectType } from '@tianji/shared';

/**
 * 回收站 F-18（最小实现：删除进回收站，支持还原，超期清理）
 * 保留 30 天（purge_after 由服务层写入 deleted_at + 30d）。
 */
@Entity('recycle_bin')
@Index('idx_recycle_object', ['objectType', 'objectId'])
@Index('idx_recycle_purge', ['purgeAfter'])
export class RecycleBin {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'object_type', type: 'varchar', length: 16 })
  objectType!: RecycleObjectType;

  @Column({ name: 'object_id', type: 'uuid' })
  objectId!: string;

  /** 对象可读标签（档号 + 题名），便于列表展示 */
  @Column({ name: 'object_label', type: 'varchar', length: 600, nullable: true })
  objectLabel!: string | null;

  /** 删除快照（用于还原时校验与留痕） */
  @Column({ type: 'jsonb', nullable: true })
  snapshot!: Record<string, unknown> | null;

  @Column({ name: 'deleted_by', type: 'uuid', nullable: true })
  deletedBy!: string | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', default: () => 'now()' })
  deletedAt!: Date;

  @Column({ name: 'purge_after', type: 'timestamptz' })
  purgeAfter!: Date;
}
