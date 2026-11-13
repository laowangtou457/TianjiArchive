import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { SecurityLevel } from '@tianji/shared';

/**
 * 条目分块向量（P4 RAG 底座）。
 *
 * 与 kb_entry 的分工（不要合并，二者语义不同）：
 *   - kb_entry   ：**人工/半自动**的片段知识条目，供「片段检索」业务用，可编辑；
 *   - item_chunk ：从全文**机器切块**得到的检索单元，只供向量召回，可随时全量重建。
 * 混在一起会导致「重建索引把人工编辑的片段冲掉」。
 *
 * 权限字段冗余（security_level / fonds_id / deleted）是**刻意冗余**：
 * 向量召回必须在 SQL 里就带上密级与数据范围过滤，不能先召回再过滤
 * （否则越权内容已经进了候选集与日志）。
 *
 * embedding 列在 DB 里是 pgvector 的 `vector(N)`；此处声明为 text 只为让 TypeORM
 * 能读写（返回的是 '[0.1,0.2,...]' 字面量），所有相似度计算走原生 SQL（<=>）。
 * 若目标库没有 pgvector，迁移会退化为 `double precision[]`，由 RagService 探测后
 * 切换为应用内余弦（详见 docs/RAG与知识库设计.md §3.2）。
 */
@Entity('item_chunk')
@Index('idx_item_chunk_item', ['itemId', 'chunkNo'])
@Index('idx_item_chunk_access', ['securityLevel', 'fondsId'])
export class ItemChunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ name: 'chunk_no', type: 'int' })
  chunkNo!: number;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'char_len', type: 'int', default: 0 })
  charLen!: number;

  /** 向量字面量（pgvector 列），未嵌入时为 null */
  @Column({ type: 'text', nullable: true })
  embedding!: string | null;

  @Column({ name: 'security_level', type: 'varchar', length: 16 })
  securityLevel!: SecurityLevel;

  @Column({ name: 'fonds_id', type: 'uuid' })
  fondsId!: string;

  @Column({ type: 'boolean', default: false })
  deleted!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
