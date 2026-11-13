import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AppraisalDecision, type Retention } from '@tianji/shared';

/**
 * 鉴定任务明细（对齐泰坦「鉴定处置表」一行一件）。
 *
 * 快照字段（danghao/title/year/retentionBefore）在生成明细时写入，
 * 之后即使原档被改也不变 —— 鉴定意见必须能对得上「当时看到的东西」。
 */
@Entity('appraisal_entry')
@Index('uk_appraisal_entry', ['taskId', 'itemId'], { unique: true })
@Index('idx_appraisal_entry_decision', ['taskId', 'decision'])
export class AppraisalEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ type: 'varchar', length: 120 })
  danghao!: string;

  @Column({ type: 'varchar', length: 500 })
  title!: string;

  @Column({ type: 'int' })
  year!: number;

  @Column({ name: 'retention_before', type: 'varchar', length: 16 })
  retentionBefore!: Retention;

  /** EXTEND 时的新期限 */
  @Column({ name: 'retention_after', type: 'varchar', length: 16, nullable: true })
  retentionAfter!: Retention | null;

  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  decision!: AppraisalDecision;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /** 处置是否已落库 */
  @Column({ type: 'boolean', default: false })
  executed!: boolean;

  @Column({ name: 'executed_at', type: 'timestamptz', nullable: true })
  executedAt!: Date | null;
}
