import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 检索历史（工作台"我的最近检索"、审计补充）
 */
@Entity('search_history')
@Index('idx_history_user_time', ['userId', 'createdAt'])
export class SearchHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  keyword!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  query!: Record<string, unknown>;

  @Column({ name: 'result_count', type: 'int', default: 0 })
  resultCount!: number;

  @Column({ name: 'took_ms', type: 'int', default: 0 })
  tookMs!: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
