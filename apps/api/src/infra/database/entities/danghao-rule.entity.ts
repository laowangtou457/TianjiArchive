import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { DanghaoSegment, ResetCycle } from '@tianji/shared';

/**
 * 档号规则 F-02（DA/T 22-2015 §5.3）
 * segments 定义段序列；规则变更只影响新著录（"新号新规则"）。
 */
@Entity('danghao_rule')
@Index('idx_rule_fonds', ['fondsId'])
@Index('idx_rule_category', ['categoryId'])
export class DanghaoRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'fonds_id', type: 'uuid' })
  fondsId!: string;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId!: string | null;

  @Column({ type: 'jsonb' })
  segments!: DanghaoSegment[];

  @Column({ type: 'varchar', length: 4, default: '-' })
  separator!: string;

  @Column({ name: 'reset_cycle', type: 'varchar', length: 16, default: 'YEAR' })
  resetCycle!: ResetCycle;

  @Column({ name: 'zero_pad', type: 'int', default: 4 })
  zeroPad!: number;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
