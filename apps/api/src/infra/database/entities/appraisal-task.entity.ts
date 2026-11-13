import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import {
  AppraisalTaskStatus,
  type Retention,
  type SecurityLevel,
} from '@tianji/shared';

/**
 * 鉴定任务 F-19（对齐泰坦「鉴定任务」主表 + 「鉴定处置表」汇总）。
 *
 * 语义：一个任务 = 一批「按筛选条件圈定 + 逐件给出处置结论」的到期档案。
 * 筛选条件是**快照**：任务生成明细后即使档案元数据变化，也不自动漂移，
 * 否则「鉴定时的依据」无法追溯（档案业务的硬要求）。
 *
 * 状态机：DRAFT → IN_PROGRESS → FINISHED；旁路 CANCELLED。
 */
@Entity('appraisal_task')
@Index('uk_appraisal_task_no', ['taskNo'], { unique: true })
@Index('idx_appraisal_task_status', ['status', 'createdAt'])
export class AppraisalTask {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 任务编号，如 JD2026-001 */
  @Column({ name: 'task_no', type: 'varchar', length: 40 })
  taskNo!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 20, default: 'DRAFT' })
  status!: AppraisalTaskStatus;

  /** 限定全宗（null = 全库范围） */
  @Column({ name: 'fonds_id', type: 'uuid', nullable: true })
  fondsId!: string | null;

  /** 年度区间（形成年度，闭区间） */
  @Column({ name: 'year_from', type: 'int' })
  yearFrom!: number;

  @Column({ name: 'year_to', type: 'int' })
  yearTo!: number;

  /** 纳入鉴定的保管期限集合（空数组 = 不限）。PG 侧用 text[] 存枚举名 */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  retentions!: Retention[];

  @Column({ name: 'category_code', type: 'varchar', length: 32, nullable: true })
  categoryCode!: string | null;

  /** 仅纳入已到期件 */
  @Column({ name: 'due_only', type: 'boolean', default: true })
  dueOnly!: boolean;

  /** 期限依据（保管期限表条款/文档说明） */
  @Column({ type: 'text', nullable: true })
  basis!: string | null;

  @Column({ type: 'text', nullable: true })
  remark!: string | null;

  /** 明细统计（冗余字段，列表页免聚合；由 service 在处置/重建后刷新） */
  @Column({ type: 'int', default: 0 })
  total!: number;

  @Column({ name: 'destroy_count', type: 'int', default: 0 })
  destroyCount!: number;

  /** 销毁审批实例 */
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

/** 供 service 复用的筛选条件快照类型 */
export interface AppraisalScopeSnapshot {
  fondsId: string | null;
  yearFrom: number;
  yearTo: number;
  retentions: Retention[];
  categoryCode: string | null;
  dueOnly: boolean;
  maxLevel?: SecurityLevel;
}
