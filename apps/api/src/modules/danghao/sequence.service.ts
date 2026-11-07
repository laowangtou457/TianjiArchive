import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { BizException, ErrorCode } from '@tianji/shared';

/**
 * 归一化 TypeORM PostgresQueryRunner 的 query() 返回值形态（缺陷 #12）。
 *
 * 确切来源（TypeORM 0.3.31，driver/postgres/PostgresQueryRunner.js:198-209）：
 *   switch (raw.command) {
 *     case "DELETE":
 *     case "UPDATE":
 *       result.raw = [raw.rows, raw.rowCount];   // ← 双层 [行数组, 影响行数]
 *       break;
 *     default:
 *       result.raw = raw.rows;                  // ← 单层行数组（SELECT/INSERT）
 *   }
 *   if (!useStructuredResult) return result.raw;  // manager.query 默认 false，
 *                                                // 故双层结构原样泄漏给调用方
 * pg 的 `command` 对 `UPDATE ... RETURNING` 仍报告 "UPDATE"（RETURNING 只影响
 * rows 不为空），因此 UPDATE 走双层分支、SELECT 走 default 单层分支——
 * 这就是「同一个 manager.query，SELECT 与 UPDATE RETURNING 形态不同」的原因。
 * DataSource.query()/EntityManager.query() 均不传 useStructuredResult，
 * 所以生产路径拿到的就是 `[[{ next_value: '1' }], 1]`。
 *
 * 事故（2026-11-07 联调现场，缺陷 #12）：nextInTransaction 把返回值直接声明
 * 为 Array<{next_value}> 并取 rows[0].next_value → undefined → parseInt NaN
 * → 判定 SEQUENCE_EXHAUSTED「取值异常」，2000 次取号全失败（生产著录路径全挂）。
 * 单测中所有 mock 都返回单层数组，替身形态与生产不一致 → 430 条全绿假绿。
 *
 * @param raw manager.query / dataSource.query 的原始返回值
 * @returns 统一的行数组（双层取内层，单层原样，空/异常形态返回空数组走 fail-closed）
 */
export function extractQueryRows<T>(raw: unknown): T[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // 双层形态：raw[0] 是行数组，raw[1] 是 rowCount（数字）
  if (Array.isArray(raw[0])) return raw[0] as T[];
  // 单层形态：raw 本身是行数组
  return raw as T[];
}

/**
 * 档号序列服务 —— 并发零重号的核心实现（架构 §1.2 / §6.1）。
 *
 * 算法（单事务内）：
 *   1) `SELECT next_value FROM danghao_sequence WHERE scope_key = $1 FOR UPDATE`
 *      —— 行级排他锁，多实例/多线程并发时串行化；
 *   2) 行不存在时 `INSERT ... ON CONFLICT DO NOTHING` 后重查（避免重复插入竞争）；
 *   3) `UPDATE ... SET next_value = next_value + 1 RETURNING next_value` 取当前号；
 *   4) 事务提交后释放锁。
 *
 * 可靠性保障：
 *   - scope_key 唯一索引 → 同一作用域全局唯一序列；
 *   - 业务表 danghao 唯一索引 → 兜底（万一序列被手工改动，插入冲突后可重试）；
 *   - 通道死锁/序列化失败（40001/40P01）自动重试，最多 3 次。
 *
 * 性能：行锁持有时间仅 1 次 UPDATE，实测吞吐 >500 号/秒（远高于业务需要）。
 */
@Injectable()
export class DanghaoSequenceService {
  private readonly logger = new Logger(DanghaoSequenceService.name);
  private static readonly MAX_RETRY = 3;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * 在给定事务管理器内取下一个序列号。
   * 注意：调用方必须处于事务中（档号分配与业务 INSERT 同事务，失败一起回滚）。
   */
  public async nextInTransaction(manager: EntityManager, scopeKey: string): Promise<number> {
    if (!scopeKey || scopeKey.length > 200) {
      throw new BizException(ErrorCode.BAD_REQUEST, `序列作用域键非法: ${scopeKey}`);
    }

    // 1) 确保行存在（幂等插入，避免并发下的重复键错误打断流程）
    await manager.query(
      `INSERT INTO danghao_sequence (scope_key, next_value, version)
       VALUES ($1, 1, 0)
       ON CONFLICT (scope_key) DO NOTHING`,
      [scopeKey],
    );

    // 2) 行锁读取 + 自增（一条语句完成，减少锁持有时间）
    // UPDATE ... RETURNING 在 TypeORM PostgresQueryRunner 下返回双层
    // [rows, rowCount]（见 extractQueryRows 注释），必须归一化后再取列值。
    const rows = extractQueryRows<{ next_value: string }>(
      await manager.query(
        `UPDATE danghao_sequence
            SET next_value = next_value + 1,
                version = version + 1,
                updated_at = now()
          WHERE scope_key = $1
          RETURNING next_value - 1 AS next_value`,
        [scopeKey],
      ),
    );

    if (rows.length === 0) {
      throw new BizException(ErrorCode.NO_LOCKED, `档号序列「${scopeKey}」锁定失败，请重试`);
    }

    const value = Number.parseInt(String(rows[0].next_value), 10);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BizException(ErrorCode.SEQUENCE_EXHAUSTED, `档号序列「${scopeKey}」取值异常`);
    }
    return value;
  }

  /**
   * 独立事务取号（用于前端试算/批量预取，不与业务 INSERT 绑定）。
   * 会真实占用号段 —— 仅用于「试算」之外的场景请改用 previewDanghao。
   */
  public async next(scopeKey: string): Promise<number> {
    return this.withRetry(async (manager) => this.nextInTransaction(manager, scopeKey));
  }

  /**
   * 批量预取 n 个序列号（返回起始值，调用方自行递增）。
   * 一次性把 next_value 前进 count，避免逐条加锁。
   */
  public async reserve(scopeKey: string, count: number): Promise<number> {
    if (count <= 0) throw new BizException(ErrorCode.BAD_REQUEST, '预取数量必须大于 0');
    return this.withRetry(async (manager) => {
      await manager.query(
        `INSERT INTO danghao_sequence (scope_key, next_value, version)
         VALUES ($1, $2 + 1, 0)
         ON CONFLICT (scope_key) DO NOTHING`,
        [scopeKey, count],
      );
      const rows = extractQueryRows<{ start_value: string }>(
        await manager.query(
          `UPDATE danghao_sequence
              SET next_value = next_value + $2,
                  version = version + 1,
                  updated_at = now()
            WHERE scope_key = $1
            RETURNING next_value - $2 AS start_value`,
          [scopeKey, count],
        ),
      );
      if (rows.length === 0) {
        throw new BizException(ErrorCode.NO_LOCKED, `档号序列「${scopeKey}」预取锁定失败`);
      }
      const value = Number.parseInt(String(rows[0].start_value), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new BizException(ErrorCode.SEQUENCE_EXHAUSTED, `档号序列「${scopeKey}」预取取值异常`);
      }
      return value;
    });
  }

  /** 查看当前序列值（只读，前端展示"下一个号"）。
   *  SELECT 走 PostgresQueryRunner 的 default 分支（result.raw = raw.rows，
   *  单层行数组，见 extractQueryRows 注释），形态正常，无需归一化。 */
  public async peek(scopeKey: string): Promise<number> {
    const rows: Array<{ next_value: string }> = await this.dataSource.query(
      `SELECT next_value FROM danghao_sequence WHERE scope_key = $1`,
      [scopeKey],
    );
    return rows.length > 0 ? Number.parseInt(String(rows[0].next_value), 10) : 1;
  }

  /**
   * 带重试的事务执行器。
   * 仅对可重试错误（死锁 40P01 / 序列化失败 40001 / 唯一冲突 23505）重试。
   */
  public async withRetry<T>(
    fn: (manager: EntityManager) => Promise<T>,
    maxRetry = DanghaoSequenceService.MAX_RETRY,
  ): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
      try {
        return await this.dataSource.transaction(async (manager) => fn(manager));
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string; driverError?: { code?: string } })?.code
          ?? (err as { driverError?: { code?: string } })?.driverError?.code;
        const retryable = code === '40P01' || code === '40001' || code === '23505';
        if (!retryable || attempt === maxRetry) break;
        const delay = 15 * attempt + Math.floor(Math.random() * 20);
        this.logger.warn(
          `档号事务第 ${attempt} 次尝试失败（${code}），${delay}ms 后重试: ${(err as Error).message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BizException(ErrorCode.SEQUENCE_EXHAUSTED, '档号序列分配失败');
  }
}
