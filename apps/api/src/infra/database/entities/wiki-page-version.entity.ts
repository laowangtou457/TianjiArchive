import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Wiki 页面版本（保存即留档，支持回滚）。
 *
 * 全量快照而非 diff：页面正文一般几 KB~几十 KB，全量存的存储代价可忽略，
 * 但回滚/对比的实现复杂度天差地别 —— 档案系统的可追溯性优先。
 * 保留策略：每页只留最近 50 版，保存时超出即淘汰最旧（由 Service 层执行）。
 */
@Entity('wiki_page_version')
@Index('uk_wiki_page_version', ['pageId', 'versionNo'], { unique: true })
export class WikiPageVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'page_id', type: 'uuid' })
  pageId!: string;

  @Column({ name: 'version_no', type: 'int' })
  versionNo!: number;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ name: 'content_md', type: 'text' })
  contentMd!: string;

  @Column({ name: 'edited_by', type: 'uuid', nullable: true })
  editedBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
