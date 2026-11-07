import {
  Column,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SecurityLevel, UserStatus } from '@tianji/shared';
import { Role } from './role.entity';

/**
 * 用户 F-09（等保 2.0 身份鉴别）
 * password_hash 使用 bcrypt 加盐；failed_count + locked_until 实现"5 次失败锁定 30 分钟"。
 */
@Entity('app_user')
export class AppUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uk_user_username', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  username!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 120 })
  passwordHash!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 64 })
  displayName!: string;

  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status!: UserStatus;

  @Column({ name: 'max_security_level', type: 'varchar', length: 16, default: 'PUBLIC' })
  maxSecurityLevel!: SecurityLevel;

  @Column({ name: 'pwd_changed_at', type: 'timestamptz', nullable: true })
  pwdChangedAt!: Date | null;

  @Column({ name: 'failed_count', type: 'int', default: 0 })
  failedCount!: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @Column({ name: 'last_login_ip', type: 'varchar', length: 64, nullable: true })
  lastLoginIp!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToMany(() => Role, (role) => role.users, { eager: false })
  @JoinTable({
    name: 'user_role',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  roles!: Role[];
}
