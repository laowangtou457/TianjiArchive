import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

/**
 * TypeORM 深层部分类型的桥接辅助。
 *
 * 背景：TypeORM 0.3 的 `QueryDeepPartialEntity<T>` 会对 `jsonb` 字段
 * （此处实体类型为 `Record<string, unknown>`）做递进展开，导致
 * `Record<string, unknown>` 无法直接赋值（索引签名与已知 key 冲突）。
 * 该字段在运行时就是任意 JSON 对象，故在更新负载边界处做一次窄化转换，
 * 既保持业务代码可读，又不放宽实体自身的类型。
 */
export function asPartialUpdate<T>(payload: Record<string, unknown>): QueryDeepPartialEntity<T> {
  return payload as unknown as QueryDeepPartialEntity<T>;
}
