import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { WorkflowBizType, WorkflowInstanceStatus } from '@tianji/shared';

/**
 * 审批流实例（一次业务动作对应一条）。
 *
 * bizType + bizId 唯一定位业务对象；payload 存提交时的关键快照
 * （如销毁件数、开放条目数），审批人据此判断，不必回查业务表。
 */
@Entity('workflow_instance')
@Index('idx_workflow_instance_biz', ['bizType', 'bizId'])
@Index('idx_workflow_instance_status', ['status', 'createdAt'])
export class WorkflowInstance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'def_id', type: 'uuid' })
  defId!: string;

  @Column({ name: 'biz_type', type: 'varchar', length: 32 })
  bizType!: WorkflowBizType;

  @Column({ name: 'biz_id', type: 'uuid' })
  bizId!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  summary!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'RUNNING' })
  status!: WorkflowInstanceStatus;

  /** 当前待处理环节序号（无待办时为最后环节 seq） */
  @Column({ name: 'current_seq', type: 'int', default: 1 })
  currentSeq!: number;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @Column({ name: 'initiator_id', type: 'uuid', nullable: true })
  initiatorId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
