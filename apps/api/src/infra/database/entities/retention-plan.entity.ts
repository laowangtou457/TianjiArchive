import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 保管期限表 P5。
 * level 为期限等级代码（PERM 永久 / Y30 定期30年 / Y10 定期10年，
 * 可与档号规则中的保管期限段对齐），years 为对应年限（永久用 -1）。
 */
@Entity('retention_plan')
export class RetentionPlan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_retention_plan_code', { unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'int' })
  years!: number;

  @Column({ type: 'varchar', length: 16, default: 'Y30' })
  level!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
