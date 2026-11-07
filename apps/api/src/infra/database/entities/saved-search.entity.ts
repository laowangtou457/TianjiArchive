import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 保存的检索条件 F-05（可共享给同事）
 */
@Entity('saved_search')
@Index('idx_saved_owner', ['ownerId'])
export class SavedSearch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'jsonb' })
  query!: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  shared!: boolean;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
