import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ApprovalAction } from '@tianji/shared';

/**
 * 借阅审批记录（全程留痕，PRD F-06）
 */
@Entity('borrow_approval')
@Index('idx_approval_order', ['orderId'])
export class BorrowApproval {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'approver_id', type: 'uuid' })
  approverId!: string;

  /** 审批级别 1/2 */
  @Column({ type: 'int', default: 1 })
  level!: number;

  @Column({ type: 'varchar', length: 16 })
  action!: ApprovalAction;

  /** 审批意见（必填） */
  @Column({ type: 'varchar', length: 500 })
  opinion!: string;

  @Column({ name: 'acted_at', type: 'timestamptz', default: () => 'now()' })
  actedAt!: Date;
}
