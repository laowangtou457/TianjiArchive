import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { AuditAction, AuditResult } from '@tianji/shared';

/**
 * 操作日志 F-10（只追加，按月分区，保留 ≥3 年）
 *
 * 迁移文件会将其改造为 `PARTITION BY RANGE (created_at)` 的分区表，
 * 并额外建 BRIN 时间索引。应用侧只做 INSERT，不支持 UPDATE/DELETE。
 */
@Entity('audit_log')
@Index('idx_audit_user_time', ['userId', 'createdAt'])
@Index('idx_audit_action_time', ['action', 'createdAt'])
@Index('idx_audit_object', ['objectType', 'objectId'])
export class AuditLog {
  /** 分区表使用 bigserial 代理键 */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', length: 32 })
  action!: AuditAction;

  @Column({ name: 'object_type', type: 'varchar', length: 32, nullable: true })
  objectType!: string | null;

  @Column({ name: 'object_id', type: 'varchar', length: 64, nullable: true })
  objectId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  result!: AuditResult;

  /** 客户端 IP（PG inet 类型） */
  @Column({ type: 'inet', nullable: true })
  ip!: string | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
