import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { OpenBatchStatus, type SecurityLevel } from '@tianji/shared';

/**
 * 开放批次 F-19（对齐泰坦「开放批次」）。
 *
 * 一个批次 = 一次开放审核工作流：圈定候选件 → 逐件给结论 → 提交审批 →
 * 审批通过后统一应用开放标识（archive_item.open_scope）。
 *
 * 为什么不直接改 open_flag：开放是**不可逆的政策动作**，必须先有批次依据
 * 与审批痕迹；单件改标识只保留给「开放设置」中的特例调整（另走审计）。
 */
@Entity('open_batch')
@Index('uk_open_batch_no', ['batchNo'], { unique: true })
@Index('idx_open_batch_status', ['status', 'createdAt'])
export class OpenBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'batch_no', type: 'varchar', length: 40 })
  batchNo!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 20, default: 'DRAFT' })
  status!: OpenBatchStatus;

  @Column({ name: 'fonds_id', type: 'uuid', nullable: true })
  fondsId!: string | null;

  @Column({ name: 'year_from', type: 'int', nullable: true })
  yearFrom!: number | null;

  @Column({ name: 'year_to', type: 'int', nullable: true })
  yearTo!: number | null;

  /** 纳入的密级（空数组 = 不限） */
  @Column({ name: 'security_levels', type: 'text', array: true, default: () => "'{}'" })
  securityLevels!: SecurityLevel[];

  @Column({ type: 'int', default: 0 })
  total!: number;

  @Column({ name: 'workflow_instance_id', type: 'uuid', nullable: true })
  workflowInstanceId!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
