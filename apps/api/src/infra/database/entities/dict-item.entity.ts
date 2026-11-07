import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 数据字典 F-14（DA/T 18-2022 受控词表）
 * 被引用的字典项禁止删除（in_use=true 时服务层拦截）。
 */
@Entity('dict_item')
@Index('uk_dict_type_code', ['dictType', 'code'], { unique: true })
export class DictItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 字典类型，如 RETENTION / SECURITY_LEVEL / BORROW_PURPOSE */
  @Column({ name: 'dict_type', type: 'varchar', length: 64 })
  dictType!: string;

  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', length: 200 })
  label!: string;

  @Column({ type: 'int', default: 0 })
  sort!: number;

  /** 是否在用（false=已停用但保留历史引用） */
  @Column({ name: 'in_use', type: 'boolean', default: true })
  inUse!: boolean;

  /** 系统内置项不可删除 */
  @Column({ type: 'boolean', default: false })
  builtin!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
