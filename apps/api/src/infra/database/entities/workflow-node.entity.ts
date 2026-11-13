import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 审批流环节（对齐泰坦 T_DA_FLOWNODE「环节」+ 环节流向/回调/权限）。
 *
 * seq 从 1 起严格递增且连续（service 校验），保证「下一环节 = seq+1」无需额外指针表。
 * roleCode='*' 表示不限定角色（仍可要求 permDomain），便于「任一具备审批权限的人处理」。
 */
@Entity('workflow_node')
@Index('uk_workflow_node_seq', ['defId', 'seq'], { unique: true })
export class WorkflowNodeRow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'def_id', type: 'uuid' })
  defId!: string;

  @Column({ type: 'int' })
  seq!: number;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  /** R0-R4 或 '*'（不限角色） */
  @Column({ name: 'role_code', type: 'varchar', length: 8, default: '*' })
  roleCode!: string;

  /** 环节要求的权限域（如 BORROW_APPROVE / APPRAISAL / PARAM） */
  @Column({ name: 'perm_domain', type: 'varchar', length: 32, nullable: true })
  permDomain!: string | null;

  /** 通过后触发的业务回调（仅末环节生效） */
  @Column({ name: 'on_approve', type: 'varchar', length: 40, nullable: true })
  onApprove!: string | null;

  @Column({ name: 'allow_reject', type: 'boolean', default: true })
  allowReject!: boolean;

  /** 超时提醒小时数（0/null = 不提醒） */
  @Column({ name: 'timeout_hours', type: 'int', nullable: true })
  timeoutHours!: number | null;
}
