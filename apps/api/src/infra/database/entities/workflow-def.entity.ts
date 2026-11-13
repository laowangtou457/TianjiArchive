import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { WorkflowBizType } from '@tianji/shared';

/**
 * 审批流定义（对齐泰坦 T_DA_FLOW_TYPE「流程类型」）。
 *
 * 一种业务类型可有多条定义，但**同一时刻只有一条 enabled=true**（由 service 保证），
 * 用 version 递增表达变更历史：改流程不覆盖旧定义，避免在途实例的环节错位。
 */
@Entity('workflow_def')
@Index('uk_workflow_def_code', ['code'], { unique: true })
@Index('idx_workflow_def_biz', ['bizType', 'enabled'])
export class WorkflowDef {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 流程编码，如 WF-OPEN-BATCH */
  @Column({ type: 'varchar', length: 60 })
  code!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ name: 'biz_type', type: 'varchar', length: 32 })
  bizType!: WorkflowBizType;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
