import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 系统参数 F-14（PRD 5.5 / 架构 §4.3）。
 *
 * 取值口径以 `@tianji/shared` 的 `PARAM_DEFS` 为唯一定义源；
 * 本实体只是持久化载体，`grp` / `editable` / `value_type` 为运维排查用冗余列。
 */
@Entity('system_param')
export class SystemParam {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_param_key', { unique: true })
  @Column({ name: 'param_key', type: 'varchar', length: 100 })
  key!: string;

  @Column({ name: 'param_value', type: 'text', default: '' })
  value!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  label!: string | null;

  /** 敏感参数（前端脱敏展示） */
  @Column({ type: 'boolean', default: false })
  secret!: boolean;

  /** 参数分组：borrow/preview/recycle/security/backup/log/file/import/obsolete */
  @Index('idx_param_grp')
  @Column({ name: 'grp', type: 'varchar', length: 32, default: 'misc' })
  grp!: string;

  /** 值类型：int/string/bool/cron/enum/csv */
  @Column({ name: 'value_type', type: 'varchar', length: 16, default: 'string' })
  valueType!: string;

  /** 是否可编辑（PR-P7 合规固化项为 false，管理端禁改） */
  @Column({ type: 'boolean', default: true })
  editable!: boolean;

  /** 最后修改人 */
  @Column({ name: 'updated_by', type: 'varchar', length: 64, nullable: true })
  updatedBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
