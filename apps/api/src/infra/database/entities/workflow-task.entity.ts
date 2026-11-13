import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { WorkflowTaskStatus } from '@tianji/shared';

/**
 * 审批流环节任务（对齐泰坦 T_DA_FLOWTASK「待办」）。
 *
 * 一个实例在每个环节生成一条任务；按角色可见（同角色多人共享同一个待办池，
 * 首个处理人认领后其余人不再可见）—— 这是「岗位审批」而非「指定人审批」的建模，
 * 与泰坦的环节权限（按角色）一致。
 */
@Entity('workflow_task')
@Index('idx_workflow_task_instance', ['instanceId', 'seq'])
@Index('idx_workflow_task_pending', ['status', 'roleCode'])
export class WorkflowTask {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'instance_id', type: 'uuid' })
  instanceId!: string;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId!: string;

  @Column({ type: 'int' })
  seq!: number;

  @Column({ name: 'node_name', type: 'varchar', length: 80 })
  nodeName!: string;

  @Column({ name: 'role_code', type: 'varchar', length: 8, default: '*' })
  roleCode!: string;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status!: WorkflowTaskStatus;

  @Column({ name: 'acted_by', type: 'uuid', nullable: true })
  actedBy!: string | null;

  @Column({ name: 'acted_by_name', type: 'varchar', length: 80, nullable: true })
  actedByName!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  opinion!: string | null;

  @Column({ name: 'acted_at', type: 'timestamptz', nullable: true })
  actedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
