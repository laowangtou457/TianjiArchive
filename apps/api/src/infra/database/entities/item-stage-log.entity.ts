import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { ItemStatus } from '@tianji/shared';

/**
 * 件级归档阶段流转日志（对齐泰坦 T_DA_FLOW_TASK 的留痕需求，按件流水而非任务单）。
 *
 * 每一次阶段动作（预归档/提交审核/确认归档/不通过/无需归档/撤回…）都写一条，
 * 不可更新不可删除 —— 监管留痕的最低底线。
 */
@Entity('item_stage_log')
@Index('idx_stage_log_item', ['itemId', 'createdAt'])
@Index('idx_stage_log_action', ['action'])
export class ItemStageLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  /** 动作代码（ItemStageAction） */
  @Column({ type: 'varchar', length: 32 })
  action!: string;

  /** 动作中文名（落库快照，避免枚举改名影响历史） */
  @Column({ name: 'action_label', type: 'varchar', length: 64 })
  actionLabel!: string;

  @Column({ name: 'from_status', type: 'varchar', length: 16, nullable: true })
  fromStatus!: ItemStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 16 })
  toStatus!: ItemStatus;

  /** 审核意见/不通过原因等 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  @Column({ name: 'operator_id', type: 'uuid', nullable: true })
  operatorId!: string | null;

  /** 操作人姓名快照（用户改名不影响历史追溯） */
  @Column({ name: 'operator_name', type: 'varchar', length: 64, nullable: true })
  operatorName!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
