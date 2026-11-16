import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Wiki 页面向量切片（/wiki/pages/ask 的检索底座）。
 *
 * 与 item_chunk（档案全文）分开建表：两边的召回域不同 ——
 * 档案问答不应命中编研笔记，Wiki 问答也不该被 7 万档案切片稀释。
 * embedding 列类型与 item_chunk 同策略：有 pgvector 用 vector(768)，
 * 否则 double precision[]（应用内余弦）。
 */
@Entity('wiki_chunk')
@Index('uk_wiki_chunk', ['pageId', 'chunkNo'], { unique: true })
@Index('idx_wiki_chunk_page', ['pageId'])
export class WikiChunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'page_id', type: 'uuid' })
  pageId!: string;

  @Column({ name: 'chunk_no', type: 'int' })
  chunkNo!: number;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'char_len', type: 'int', default: 0 })
  charLen!: number;

  // 注意：embedding 列不在实体中声明（vector / 数组两种物理类型无法用单一
  // TypeORM 类型表达），全部检索走原生 SQL —— 与 RagService 的做法一致。

  @Column({ type: 'boolean', default: false })
  deleted!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
