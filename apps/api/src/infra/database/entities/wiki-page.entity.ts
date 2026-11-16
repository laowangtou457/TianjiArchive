import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Wiki 页面（树形：parent_id 指向同空间父页）。
 *
 * 正文存 Markdown 原文（content_md），渲染在前端；
 * version_no 每次保存 +1，历史全量落 wiki_page_version（可回滚）。
 * 页面保存后同步切片入 wiki_chunk（向量库），供 /wiki/pages/ask 检索问答。
 */
@Entity('wiki_page')
@Index('idx_wiki_page_space', ['spaceId', 'deleted'])
@Index('idx_wiki_page_parent', ['parentId'])
export class WikiPage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  /** Markdown 原文 */
  @Column({ name: 'content_md', type: 'text', default: '' })
  contentMd!: string;

  /** 同级排序号（小在前） */
  @Column({ name: 'order_no', type: 'int', default: 0 })
  orderNo!: number;

  /** 当前版本号（从 1 起，每次保存 +1） */
  @Column({ name: 'version_no', type: 'int', default: 1 })
  versionNo!: number;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @Column({ type: 'boolean', default: false })
  deleted!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
