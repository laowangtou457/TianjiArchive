import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { BackupStatus } from '@tianji/shared';

/**
 * 备份记录 F-11（备份成功率报表 + 恢复演练留档）
 */
@Entity('backup_record')
@Index('idx_backup_started', ['startedAt'])
export class BackupRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  filename!: string;

  @Column({ name: 'storage_path', type: 'varchar', length: 500 })
  storagePath!: string;

  @Column({ name: 'size_bytes', type: 'bigint', default: 0 })
  sizeBytes!: string;

  @Column({ type: 'char', length: 64, nullable: true })
  sha256!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'RUNNING' })
  status!: BackupStatus;

  @Column({ name: 'db_status', type: 'varchar', length: 16, nullable: true })
  dbStatus!: string | null;

  @Column({ name: 'minio_status', type: 'varchar', length: 16, nullable: true })
  minioStatus!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  /** 触发人（null 表示定时任务） */
  @Column({ name: 'triggered_by', type: 'uuid', nullable: true })
  triggeredBy!: string | null;
}
