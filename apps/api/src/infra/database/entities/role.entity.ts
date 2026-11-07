import { Column, Entity, Index, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';
import type { PermissionGrant, RoleCode } from '@tianji/shared';
import { AppUser } from './user.entity';

/**
 * 角色 F-09
 * permissions 为功能域授权声明数组（角色 × 功能域的权限矩阵，PRD §3.2）。
 */
@Entity('role')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_role_code', { unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: RoleCode;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  permissions!: PermissionGrant[];

  /** 内置角色不可删除（R0~R4） */
  @Column({ type: 'boolean', default: false })
  builtin!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToMany(() => AppUser, (user) => user.roles)
  users!: AppUser[];
}
