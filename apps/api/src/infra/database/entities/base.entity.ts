import { CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 公共实体基类：UUID 主键 + 创建/更新时间。
 * 时间统一 timestamptz（架构 §11）。
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * 带乐观更新时间的基类（用于软删除实体）。
 * 注意：软删除统一用 `deleted` 布尔列（架构 §11），不使用 TypeORM 的 @DeleteDateColumn，
 * 以便与原生 SQL / 条件检索保持一致。
 */
export abstract class SoftDeleteEntity extends BaseEntity {
  /** 软删除标记：true 表示已进回收站 */
  @CreateDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
