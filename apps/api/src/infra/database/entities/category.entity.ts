import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { MetadataFieldDef } from '@tianji/shared';

/**
 * 档案门类 F-12（DA/T 22-2015 §4 分类方案）
 * field_schema 定义该门类的动态著录字段集；核心字段（core=true）不可裁剪。
 */
@Entity('category')
export class Category {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_category_code', { unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** 动态著录字段集 */
  @Column({ name: 'field_schema', type: 'jsonb', default: () => "'[]'::jsonb" })
  fieldSchema!: MetadataFieldDef[];

  @Column({ name: 'danghao_rule_id', type: 'uuid', nullable: true })
  danghaoRuleId!: string | null;

  @Column({ type: 'int', default: 0 })
  sort!: number;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
