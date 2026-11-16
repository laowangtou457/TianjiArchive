import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Wiki 空间（知识 Wiki 的顶层容器，如「编研专栏」「业务知识」）。
 *
 * 密级在空间级声明，页面继承 —— 页面级再设密级会让「页面在哪个库」变成
 * 需要逐页判断的问题，树形浏览时反而容易漏。空间密级变更时全库页面随之
 * 收紧/放宽，语义清晰可审计。
 */
@Entity('wiki_space')
@Index('uk_wiki_space_name', ['name'], { unique: true })
export class WikiSpace {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  /** 空间密级上限：PUBLIC / INTERNAL / SECRET，页面内容按此过滤 */
  @Column({ name: 'security_level', type: 'varchar', length: 16, default: 'INTERNAL' })
  securityLevel!: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  /** 软删除：与全库约定一致（deleted 布尔） */
  @Column({ type: 'boolean', default: false })
  deleted!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
