import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { DataScopeType } from '@tianji/shared';

/**
 * 用户数据范围授权（四要素之「数据范围」）
 * scope_type=ALL 时 scope_ref_id 为空；FONDS 指向 fonds.id；ORG 指向 org_node.id；SELF 无 ref。
 */
@Entity('user_data_scope')
@Index('idx_scope_user', ['userId'])
export class UserDataScope {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'scope_type', type: 'varchar', length: 16 })
  scopeType!: DataScopeType;

  @Column({ name: 'scope_ref_id', type: 'uuid', nullable: true })
  scopeRefId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
