import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 扩展功能通用记录表（P6 门类扩展 / P7 接收移交四性 ERMS / P8 实体与增值）。
 *
 * 一张表承载所有「配置 / 清单 / 流程单据」型功能，通过 category 区分业务：
 *   RECEIVE_PACKAGE / DATALINK_BATCH / TRANSFER / ERMS_PACKAGE / STOCK_ROOM /
 *   AUX_ENTITY / COMPILATION / NOTICE / DOWNLOAD / METADATA / TEMPLATE /
 *   REPORT_DESIGN / ERCHECK_ITEM / CATEGORY_TEMPLATE / USAGE_LOG ...
 *
 * 复杂业务字段（条目清单、规则、检测结果、视图配置等）统一落在 bodyJson，
 * 避免为十几个配置型功能各建一张表。状态流转由 extension 模块 Service 统一执行。
 */
@Entity('extension_record')
export class ExtensionRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 业务分类（区分该记录属于哪个功能） */
  @Index('idx_extension_record_category')
  @Column({ type: 'varchar', length: 64 })
  category!: string;

  /** 标题（列表主列） */
  @Column({ type: 'varchar', length: 200 })
  title!: string;

  /** 业务载荷（JSON） */
  @Column({ name: 'body_json', type: 'jsonb', default: () => "'{}'::jsonb" })
  bodyJson!: Record<string, unknown>;

  /** 业务状态：DRAFT / PENDING / CONFIRMED / REJECTED / PUBLISHED / COMPLETED ... */
  @Index('idx_extension_record_status')
  @Column({ type: 'varchar', length: 32, default: 'DRAFT' })
  status!: string;

  /** 是否启用（配置型记录可停用而非删除） */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** 创建人（用户 ID） */
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
