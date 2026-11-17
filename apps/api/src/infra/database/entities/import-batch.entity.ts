import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { SecurityLevel } from '@tianji/shared';

/** 导入批次状态（建立 → 上传 → 确认） */
export type ImportBatchStatus = 'CREATED' | 'UPLOADED' | 'CONFIRMED';

/** 模板列映射：决定 CSV 第 N 列对应哪个档案字段 */
export interface ImportTemplateField {
  key: 'danghao' | 'title' | 'responsible' | 'year' | 'securityLevel';
  label: string;
  enabled: boolean;
}

/** 导入明细行（解析 + 校验 + 入库结果） */
export interface ImportDetailRow {
  /** 文本行号（从 1 开始，不含表头） */
  line: number;
  /** 原始列值（按模板字段 key 索引） */
  values: Record<string, string>;
  danghao: string;
  title: string;
  responsible: string | null;
  year: number | null;
  securityLevel: SecurityLevel;
  /** 档号必填校验是否通过 */
  valid: boolean;
  error: string | null;
  /** 确认入库时是否已写入 archive_item */
  imported: boolean;
}

/**
 * 数据导入批次 P5（对齐泰坦「建立批次 → 模板配置 → 数据导入 → 确认 → 记录明细」五步）。
 * detailJson 保存解析后的明细与校验/入库结果，便于全程追溯。
 */
@Entity('import_batch')
export class ImportBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_import_batch_no', { unique: true })
  @Column({ name: 'batch_no', type: 'varchar', length: 64 })
  batchNo!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'CREATED' })
  status!: ImportBatchStatus;

  /** 第二步「模板配置」选中的列映射 */
  @Column({ name: 'template_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  templateJson!: ImportTemplateField[];

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ name: 'file_count', type: 'int', default: 0 })
  fileCount!: number;

  @Column({ name: 'success_count', type: 'int', default: 0 })
  successCount!: number;

  @Column({ name: 'fail_count', type: 'int', default: 0 })
  failCount!: number;

  @Column({ name: 'detail_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  detailJson!: ImportDetailRow[];
}
