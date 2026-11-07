import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 档号序列（架构 §4.2）—— 并发零重号的核心。
 *
 * 分配算法（sequence.service.ts）：
 *   BEGIN;
 *   SELECT next_value FROM danghao_sequence WHERE scope_key = $1 FOR UPDATE;  -- 行锁
 *   （不存在则 INSERT ... ON CONFLICT DO NOTHING 后重查）
 *   UPDATE danghao_sequence SET next_value = next_value + 1;
 *   COMMIT;
 * 行锁 + scope_key 唯一索引保证多实例并发下不重号；
 * 业务表 danghao 唯一索引作为兜底（冲突时重试取下一号）。
 */
@Entity('danghao_sequence')
export class DanghaoSequence {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 作用域键，如 'A036|2024|BGS|Y|V:Y' */
  @Index('uk_seq_scope', { unique: true })
  @Column({ name: 'scope_key', type: 'varchar', length: 200 })
  scopeKey!: string;

  /** 下一个可用值 */
  @Column({ name: 'next_value', type: 'bigint', default: 1 })
  nextValue!: string;

  /** 版本（便于排查并发分配异常） */
  @Column({ type: 'int', default: 0 })
  version!: number;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
