/**
 * 档号并发分配 —— 单元级并发模拟（Docker 不可用时的替代验证）
 *
 * 背景：架构验收要求「并发 50 线程抢号零重号」，正式验证需 `pnpm --filter @tianji/api perf:danghao`
 * 连真实 PostgreSQL（依赖 FOR UPDATE 行锁）。本机无 Docker，无法启动 PG，
 * 因此这里用**进程内串行化模拟行锁语义**验证：
 *   ① DanghaoSequenceService 的 SQL 语义（自增 + RETURNING next_value - 1）；
 *   ② 在「同一 scope_key 全局互斥」前提下，Promise.all(200) 抢号零重号、零断号；
 *   ③ scope_key 隔离正确：不同全服/年度/机构互不干扰；
 *   ④ 非重试性错误立即抛出，可重试错误最多重试 3 次后抛 SEQUENCE_EXHAUSTED。
 *
 * ⚠️ 风险提示：该模拟**不能**证明 PostgreSQL 行锁在真实并发下的行为（死锁检测、事务隔离级别、
 * 序列冲突重试路径），真实结论仍需在有 Docker 的环境跑 perf:danghao 脚本。
 *
 * ⚠️ 替身形态（缺陷 #12 教训）：FakeSequenceTable.query 的 UPDATE 分支**必须**
 * 返回 TypeORM PostgresQueryRunner 的真实双层形态 `[[rows], rowCount]`。
 * 此前所有 mock 都返回单层数组，与生产路径不一致，导致 430 条单测全绿却
 * 挡不住「UPDATE RETURNING 双层返回 → parseInt(undefined) → NaN → 取值异常」
 * 的确定性生产故障。本项目第三例「假绿」，mock 形态须与驱动实测对齐。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DanghaoSequenceService,
  extractQueryRows,
} from '@api/modules/danghao/sequence.service';
import { buildScopeKey, DEFAULT_DANGHAO_TEMPLATE, renderDanghao } from '@tianji/shared';

/**
 * 模拟一张 danghao_sequence 表 + 行级互斥锁。
 * 这里的「锁」用 JS 单线程 + 串行队列近似 PostgreSQL 的 SELECT ... FOR UPDATE。
 */
class FakeSequenceTable {
  private rows = new Map<string, number>(); // scope_key → next_value
  private tails = new Map<string, Promise<unknown>>(); // scope_key → 串行队列尾

  /** 在「行锁」内执行 fn（同一 scope_key 严格串行） */
  public async withLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(scopeKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    this.tails.set(scopeKey, prev.then(() => current));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public async query(sql: string, params: unknown[] = []): Promise<Array<Record<string, string>>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const scopeKey = String(params[0] ?? '');

    if (normalized.startsWith('INSERT INTO danghao_sequence')) {
      if (!this.rows.has(scopeKey)) {
        // 对应 INSERT ... ON CONFLICT DO NOTHING，初始 next_value = 1
        this.rows.set(scopeKey, 1);
      }
      return [];
    }
    if (normalized.startsWith('UPDATE danghao_sequence')) {
      // 生产形态：PostgresQueryRunner.js:198-209 对 UPDATE/DELETE 返回
      // result.raw = [raw.rows, raw.rowCount]（双层）。SELECT 才是单层。
      return this.withLock(scopeKey, async () => {
        const current = this.rows.get(scopeKey);
        if (current === undefined) return [[], 0] as unknown as Array<Record<string, string>>;
        this.rows.set(scopeKey, current + 1);
        return [[{ next_value: String(current) }], 1] as unknown as Array<Record<string, string>>;
      });
    }
    if (normalized.startsWith('SELECT next_value FROM danghao_sequence')) {
      const v = this.rows.get(scopeKey);
      return v === undefined ? [] : [{ next_value: String(v) }];
    }
    throw new Error(`未模拟的 SQL: ${normalized}`);
  }

  public peek(scopeKey: string): number | undefined {
    return this.rows.get(scopeKey);
  }
}

function makeService(table: FakeSequenceTable, transactionImpl?: (cb: (m: unknown) => Promise<unknown>) => Promise<unknown>) {
  const manager = { query: table.query.bind(table) };
  const dataSource = {
    transaction:
      transactionImpl ??
      (async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    query: table.query.bind(table),
  };
  return new DanghaoSequenceService(dataSource as never);
}

// ============================================================================
describe('DanghaoSequenceService 取号语义', () => {
  let table: FakeSequenceTable;
  let service: DanghaoSequenceService;

  beforeEach(() => {
    table = new FakeSequenceTable();
    service = makeService(table);
  });

  it('首次取号返回 1，之后严格 +1', async () => {
    expect(await service.next('scope-a')).toBe(1);
    expect(await service.next('scope-a')).toBe(2);
    expect(await service.next('scope-a')).toBe(3);
  });

  it('peek 只读不消耗号', async () => {
    await service.next('scope-a');
    expect(await service.peek('scope-a')).toBe(2);
    expect(await service.peek('scope-a')).toBe(2);
  });

  it('未初始化的 scope，peek 返回 1', async () => {
    expect(await service.peek('never-used')).toBe(1);
  });

  it('scope_key 为空 → 1001 拒绝', async () => {
    await expect(service.next('')).rejects.toMatchObject({ code: 1001 });
  });

  it('scope_key 超过 200 字符 → 1001（防列溢出）', async () => {
    await expect(service.next('x'.repeat(201))).rejects.toMatchObject({ code: 1001 });
  });

  it('不同 scope_key 各自独立计数（互不干扰）', async () => {
    await service.next('A|2024|V:Y');
    await service.next('A|2024|V:Y');
    expect(await service.next('A|2025|V:Y')).toBe(1);
    expect(await service.next('B|2024|V:Y')).toBe(1);
  });
});

// ============================================================================
describe('【并发压测】200 并发 × 10 轮 —— 零重号零断号（单元级模拟）', () => {
  const CONCURRENCY = 200;
  const ROUNDS = 10;

  it(`同一 scope_key 下 ${CONCURRENCY} 并发 × ${ROUNDS} 轮，号段完整无重复`, async () => {
    const table = new FakeSequenceTable();
    const service = makeService(table);
    const scopeKey = buildScopeKey(
      DEFAULT_DANGHAO_TEMPLATE,
      { fondsNo: 'A036', year: 2024, orgCode: 'BGS', retentionCode: 'Y' },
      'ITEM',
      'YEAR',
    );

    const all: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const got = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => service.next(scopeKey)),
      );
      all.push(...got);
    }

    // ① 零重号
    expect(new Set(all).size).toBe(all.length);
    // ② 零断号：1..N 连续
    const sorted = [...all].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: CONCURRENCY * ROUNDS }, (_, i) => i + 1));
    // ③ 无越界
    expect(Math.max(...all)).toBe(CONCURRENCY * ROUNDS);
    expect(Math.min(...all)).toBe(1);
  });

  it(`并发下渲染出的档号 ${CONCURRENCY * 4} 条全部唯一`, async () => {
    const table = new FakeSequenceTable();
    const service = makeService(table);
    const scopeKey = 'A036|2024|BGS|Y|I:VOLUME';
    const nos = await Promise.all(
      Array.from({ length: CONCURRENCY * 4 }, () => service.next(scopeKey)),
    );
    const danghaos = nos.map((itemNo) =>
      renderDanghao(DEFAULT_DANGHAO_TEMPLATE, {
        fondsNo: 'A036',
        year: 2024,
        orgCode: 'BGS',
        retentionCode: 'Y',
        volumeNo: 1,
        itemNo,
      }),
    );
    expect(new Set(danghaos).size).toBe(danghaos.length);
  });

  it('多 scope 并发（模拟多全宗同时入账）各 scope 内仍连续', async () => {
    const table = new FakeSequenceTable();
    const service = makeService(table);
    const scopes = ['S1', 'S2', 'S3', 'S4'];
    const perScope = await Promise.all(
      scopes.map(async (s) => ({
        scope: s,
        values: await Promise.all(Array.from({ length: 50 }, () => service.next(s))),
      })),
    );
    for (const { scope, values } of perScope) {
      const sorted = [...values].sort((a, b) => a - b);
      expect(sorted, `scope ${scope} 号段不连续`).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
    }
  });
});

// ============================================================================
describe('withRetry —— 事务重试策略', () => {
  it('可重试错误（40001 序列化失败）在第 2 次成功后返回结果', async () => {
    let attempt = 0;
    const dataSource = {
      transaction: async (cb: (m: unknown) => Promise<unknown>) => {
        attempt += 1;
        if (attempt === 1) {
          const err = new Error('could not serialize access') as Error & { code: string };
          err.code = '40001';
          throw err;
        }
        return cb({});
      },
      query: async () => [],
    };
    const service = new DanghaoSequenceService(dataSource as never);
    const result = await service.withRetry(async () => 'ok');
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('可重试错误连续 3 次 → 抛出原始错误（不无限重试）', async () => {
    let attempt = 0;
    const err = Object.assign(new Error('deadlock'), { code: '40P01' });
    const dataSource = {
      transaction: async () => {
        attempt += 1;
        throw err;
      },
      query: async () => [],
    };
    const service = new DanghaoSequenceService(dataSource as never);
    await expect(service.withRetry(async () => 'never')).rejects.toThrow('deadlock');
    expect(attempt).toBe(3);
  });

  it('非可重试错误（如 23503 外键）立即抛出，不重试', async () => {
    let attempt = 0;
    const dataSource = {
      transaction: async () => {
        attempt += 1;
        throw Object.assign(new Error('fk violation'), { code: '23503' });
      },
      query: async () => [],
    };
    const service = new DanghaoSequenceService(dataSource as never);
    await expect(service.withRetry(async () => 'never')).rejects.toThrow('fk violation');
    expect(attempt).toBe(1);
  });

  it('maxRetry 可覆盖（预取场景可指定更少重试）', async () => {
    let attempt = 0;
    const dataSource = {
      transaction: async () => {
        attempt += 1;
        throw Object.assign(new Error('deadlock'), { code: '40P01' });
      },
      query: async () => [],
    };
    const service = new DanghaoSequenceService(dataSource as never);
    await expect(service.withRetry(async () => 'x', 1)).rejects.toThrow('deadlock');
    expect(attempt).toBe(1);
  });
});

// ============================================================================
// 缺陷 #12 防回归：TypeORM PostgresQueryRunner 的 UPDATE RETURNING 双层返回
//
// 生产实测（容器内真 AppDataSource）：
//   manager.query('SELECT 2 AS y')                       → [{y:2}]                 单层
//   manager.query('UPDATE ... RETURNING next_value-1')  → [[{next_value:'1'}],1]  双层
// 修复前：nextInTransaction 直接取 rows[0].next_value → undefined → NaN →
// 「取值异常」，2000/2000 取号失败（生产著录路径全挂）。
// 变异验证：把 nextInTransaction/reserve 改回直接取 rows[0].next_value，
// 本 describe 的双层主用例与上面全部 mock 已改双层的既有用例都会红。
// ============================================================================
describe('缺陷 #12：UPDATE RETURNING 双层返回归一化', () => {
  /** 构造只回答 INSERT/UPDATE 两类 SQL 的 manager 桩（形态可注入） */
  function managerWithUpdateResult(raw: unknown) {
    const seen: string[] = [];
    const manager = {
      query: async (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        seen.push(normalized.split(' ')[0] ?? '');
        // INSERT 走 PostgresQueryRunner default 分支：单层空行数组
        if (normalized.startsWith('INSERT')) return [];
        return raw;
      },
    };
    return { manager, seen };
  }

  it('extractQueryRows：双层取内层行数组，单层原样，空/异常形态 fail-closed', () => {
    expect(extractQueryRows<{ next_value: string }>([[{ next_value: '7' }], 1])).toEqual([
      { next_value: '7' },
    ]);
    expect(extractQueryRows<{ next_value: string }>([{ next_value: '42' }])).toEqual([
      { next_value: '42' },
    ]);
    expect(extractQueryRows([[], 0])).toEqual([]);
    expect(extractQueryRows([])).toEqual([]);
    expect(extractQueryRows(null)).toEqual([]);
    expect(extractQueryRows('garbage')).toEqual([]);
  });

  it('nextInTransaction 主用例：真实双层结构解析出正整数（修复前的红点）', async () => {
    const raw = [[{ next_value: '7' }], 1];
    // 正向证据：夹具本身确实是双层（防止 mock 悄悄退化成单层让断言空转）
    expect(Array.isArray(raw[0])).toBe(true);
    const { manager, seen } = managerWithUpdateResult(raw);
    const service = new DanghaoSequenceService({} as never);

    const value = await service.nextInTransaction(manager as never, 'S');

    expect(value).toBe(7);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(seen).toEqual(['INSERT', 'UPDATE']);
  });

  it('nextInTransaction 单层形态兼容（旧 mock / 其他驱动形态不回归）', async () => {
    const { manager } = managerWithUpdateResult([{ next_value: '42' }]);
    const service = new DanghaoSequenceService({} as never);

    expect(await service.nextInTransaction(manager as never, 'S')).toBe(42);
  });

  it('UPDATE 双层但零行 → NO_LOCKED 锁定失败，不静默返回', async () => {
    const { manager } = managerWithUpdateResult([[], 0]);
    const service = new DanghaoSequenceService({} as never);

    await expect(service.nextInTransaction(manager as never, 'S')).rejects.toThrow('锁定失败');
  });

  it('reserve 同样归一化双层：返回正整数，零行不再静默回落到 1', async () => {
    const dataSourceWith = (raw: unknown) => {
      const { manager } = managerWithUpdateResult(raw);
      return {
        transaction: async (cb: (m: unknown) => Promise<unknown>) => cb(manager),
      };
    };

    const okService = new DanghaoSequenceService(
      dataSourceWith([[{ start_value: '11' }], 1]) as never,
    );
    expect(await okService.reserve('S', 5)).toBe(11);

    const emptyService = new DanghaoSequenceService(dataSourceWith([[], 0]) as never);
    await expect(emptyService.reserve('S', 5)).rejects.toThrow('预取锁定失败');
  });

  it('peek 走 SELECT 单层形态，无需改动（回归确认）', async () => {
    const service = new DanghaoSequenceService({
      query: async () => [{ next_value: '9' }],
    } as never);

    expect(await service.peek('S')).toBe(9);
  });
});
