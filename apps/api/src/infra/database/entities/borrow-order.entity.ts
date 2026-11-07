import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BorrowMode, BorrowStatus } from '@tianji/shared';

/**
 * 借阅申请单 F-06
 * 状态机：PENDING → APPROVED → LENT → RETURNED，支线 REJECTED / CANCELLED / OVERDUE
 */
@Entity('borrow_order')
@Index('uk_borrow_order_no', ['orderNo'], { unique: true })
@Index('idx_borrow_applicant', ['applicantId', 'status'])
@Index('idx_borrow_item', ['itemId'])
@Index('idx_borrow_status_due', ['status', 'expectReturn'])
export class BorrowOrder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 借阅单号，如 L20240512-003 */
  @Column({ name: 'order_no', type: 'varchar', length: 40 })
  orderNo!: string;

  @Column({ name: 'applicant_id', type: 'uuid' })
  applicantId!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ type: 'varchar', length: 500 })
  purpose!: string;

  @Column({ type: 'varchar', length: 16 })
  mode!: BorrowMode;

  @Column({ name: 'expect_return', type: 'date' })
  expectReturn!: string;

  /**
   * 借出日（实际办理借出的日期，YYYY-MM-DD）。
   *
   * 用途：BR-06-3 计算「总借期」的基准日 —— 续借校验必须用 `新应还日 − 借出日 ≤ 90 天`，
   * 而不是「距今天数」，否则逾期单会因天数为负被反向漏判。
   * 未借出（PENDING/APPROVED）时为 null。
   */
  @Column({ name: 'borrow_date', type: 'date', nullable: true })
  borrowDate!: string | null;

  @Column({ name: 'actual_return', type: 'timestamptz', nullable: true })
  actualReturn!: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status!: BorrowStatus;

  @Column({ name: 'renew_count', type: 'int', default: 0 })
  renewCount!: number;

  /** 当前审批级别（秘密级需两级：1→2） */
  @Column({ name: 'current_level', type: 'int', default: 1 })
  currentLevel!: number;

  /** 需要的总审批级别（按密级路由：PUBLIC/INTERNAL=1，SECRET=2） */
  @Column({ name: 'required_level', type: 'int', default: 1 })
  requiredLevel!: number;

  @Column({ name: 'return_remark', type: 'varchar', length: 500, nullable: true })
  returnRemark!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
