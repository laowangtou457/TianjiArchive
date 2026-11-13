import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 检索同义词组（对齐泰坦 DARMS「同义词」维护功能）。
 *
 * ## 为什么是「组」而不是「A→B 映射」
 *
 * 同义关系是**等价关系**：档案 = 卷宗 = 案卷。若存成 A→B 的映射，维护者必须
 * 把每对都写一遍（A→B、B→A、A→C…），漏一条就出现「搜 A 能出 C、搜 C 搜不到 A」
 * 的诡异结果，且无法表达传递性。存成组后，`words` 里任意一个词命中，
 * 其余词都作为扩展词参与召回，语义自洽、维护成本最低。
 *
 * ## 生效方式
 *
 * 检索时在查询层做扩展（不是 ES 索引期同义词 filter），理由：
 *   - 改完立即生效，无需关索引/重建，归档系统不可停机；
 *   - 同义词是业务配置，改了要能马上验证效果，重建索引动辄数分钟；
 *   - 扩展权重可控（原词 boost 1.0，同义词 0.6），避免同义词把精确命中挤下去。
 */
@Entity('search_synonym')
@Index('idx_synonym_enabled', ['enabled'])
export class SearchSynonym {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 等价词组（至少 2 个），如 ['档案','卷宗','案卷'] */
  @Column({ type: 'text', array: true })
  words!: string[];

  /** 备注：说明这组词的业务来源（便于审计与清理） */
  @Column({ type: 'varchar', length: 200, nullable: true })
  note!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
