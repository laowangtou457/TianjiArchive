import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { OpenDecision, type SecurityLevel } from '@tianji/shared';

/**
 * 开放审核明细（对齐泰坦四态：条目开放 / 原文开放 / 不开放 / 再审查）。
 *
 * 一件在一个批次里只出现一次（uk_open_review_batch_item）；
 * 若要重新审核同一件，应新建批次（保留「上次为什么不开放」的依据）。
 */
@Entity('open_review')
@Index('uk_open_review_batch_item', ['batchId', 'itemId'], { unique: true })
@Index('idx_open_review_decision', ['batchId', 'decision'])
export class OpenReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ type: 'varchar', length: 120 })
  danghao!: string;

  @Column({ type: 'varchar', length: 500 })
  title!: string;

  @Column({ type: 'int' })
  year!: number;

  @Column({ name: 'security_level', type: 'varchar', length: 16 })
  securityLevel!: SecurityLevel;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  decision!: OpenDecision;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  @Column({ name: 'reviewer_id', type: 'uuid', nullable: true })
  reviewerId!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  /** 开放标识实际落库时间（审批通过后统一应用） */
  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt!: Date | null;
}
