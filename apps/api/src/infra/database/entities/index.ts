/**
 * TypeORM 实体统一出口。
 * 所有实体集中在此导出，供 DataSource、TypeOrmModule 与迁移脚本复用，避免循环引用。
 */
export * from './base.entity';
export * from './fonds.entity';
export * from './org-node.entity';
export * from './category.entity';
export * from './danghao-rule.entity';
export * from './danghao-sequence.entity';
export * from './volume.entity';
export * from './archive-item.entity';
export * from './electronic-file.entity';
export * from './document-text.entity';
export * from './borrow-order.entity';
export * from './borrow-approval.entity';
export * from './user.entity';
export * from './role.entity';
export * from './user-data-scope.entity';
export * from './audit-log.entity';
export * from './dict-item.entity';
export * from './system-param.entity';
export * from './kb-entry.entity';
export * from './recycle-bin.entity';
export * from './saved-search.entity';
export * from './search-history.entity';
export * from './backup-record.entity';
