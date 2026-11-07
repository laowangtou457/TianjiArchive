/**
 * 档号并发压测的通过判据（硬性验收要点 1）。
 *
 * **本文件刻意零依赖**：不 import 任何 DB / 实体 / Nest 模块，
 * 因此可以被单测直接 import，无需 mock `AppDataSource`。
 *
 * 这拆分不是洁癖：`danghao-concurrency-bench.ts` 顶层 import 了
 * `AppDataSource` 与 TypeORM 实体（带装饰器），直接 import 该文件会在
 * 未初始化 reflect-metadata 时抛 `Cannot read properties of undefined
 * (reading 'constructor')`。判据若与它同处一个模块，就永远测不到。
 *
 * 判据本身的职责边界：
 *   - 只吃**聚合统计量**（`BenchStats`），不吃逐轮明细 —— 明细属诊断信息；
 *   - 只回答「过没过、哪几条没过」，不做 IO、不打印、不退出进程。
 */

/**
 * 判据所需的全量统计量。
 *
 * 刻意做成**纯数据**、不含 `rounds` 明细数组——判据只关心聚合值，
 * 逐轮明细属于诊断信息，不进判据。这样单测可以零夹具构造任意场景。
 */
export interface BenchStats {
  /** 内存层重号条数（同一档号出现多次的次数） */
  totalDuplicate: number;
  /** 取号失败数（事务抛错） */
  totalRejected: number;
  /** 落库总数 */
  dbTotal: number;
  /** 落库去重后总数 */
  dbDistinct: number;
  /** 内存层成功取号总数 */
  totalSuccess: number;
  /** 并发度（单轮取号数） */
  concurrency: number;
  /** 轮数 */
  rounds: number;
  /** 各轮 gaps 合计（单轮内序号空洞数之和） */
  totalGaps: number;
}

/** 判据结论 */
export interface BenchVerdict {
  /** 六项判据是否全部满足 */
  pass: boolean;
  /** 未满足的判据说明（pass=true 时为空数组） */
  reasons: string[];
}

/**
 * 档号并发压测的通过判据（**纯函数，无副作用、不依赖 DB**）。
 *
 * 六项判据缺一不可：
 *
 * | # | 条件                           | 含义             | 不满足说明什么             |
 * |---|--------------------------------|------------------|----------------------------|
 * | 1 | totalDuplicate === 0           | 内存层零重号     | 序列自增不是原子的         |
 * | 2 | totalRejected === 0            | 零取号失败       | 锁竞争过激 / 超时          |
 * | 3 | dbTotal === dbDistinct         | 落库后零重号     | 唯一索引没拦住（最严重）   |
 * | 4 | dbTotal === totalSuccess       | 内存与落库数一致 | 事务提交丢失               |
 * | 5 | dbTotal === concurrency×rounds | 全部取号都拿到了 | 有号被静默吞掉             |
 * | 6 | totalGaps === 0                | 序号区间无空洞   | 序列跳号——档号被"吃掉"     |
 *
 * ## 第 6 项为什么不可省
 *
 * 条件 5 只约束**取号总数**，不约束**序号连续性**。单轮拿到
 * `1,2,3,7,8,…,203` 共 200 个号时，`gaps = 3`（跳过 4/5/6），
 * 但 `dbTotal` 仍凑满——**前五项全绿，档号被"吃掉"却判定通过**。
 * 档号缺号与重号同级严重：编号永久空缺，将来可能被误用或对不上账。
 *
 * ## 为什么用「合计」而不是「逐轮」
 *
 * 每轮 `gaps = MAX - MIN + 1 - COUNT` 恒非负（不同序号数不会超过区间长度），
 * 故「合计为 0」⟺「每轮为 0」。两种写法等价，这里用合计是因为
 * `BenchStats` 只带聚合值——逐轮明细留在调用方的 `rounds[]` 里供诊断输出。
 * 若将来加入会产生负 gaps 的场景，须改为逐轮 `every`。
 *
 * ## 边界：gaps 只覆盖「单轮内」跳号
 *
 * `gaps` 是单轮内计算的，而探针表每轮 `TRUNCATE`，所以它发现不了
 * **跨轮**丢号。跨轮缺失由条件 5（`dbTotal === concurrency×rounds`）兜住。
 * 两者互补，但含义不同，读报告时勿混。
 *
 * @param stats 聚合统计量
 * @returns 判据结论，`reasons` 列出每一项不满足的具体原因
 */
export function evaluatePass(stats: BenchStats): BenchVerdict {
  const expected = stats.concurrency * stats.rounds;
  const reasons: string[] = [];

  if (stats.totalDuplicate !== 0) {
    reasons.push(`重号 ${stats.totalDuplicate} 个（内存层判重发现重复档号，序列自增可能非原子）`);
  }
  if (stats.totalRejected !== 0) {
    reasons.push(`取号失败 ${stats.totalRejected} 次（事务抛错，检查锁竞争/超时/唯一约束冲突）`);
  }
  if (stats.dbTotal !== stats.dbDistinct) {
    reasons.push(
      `落库重号：总数 ${stats.dbTotal}，去重后 ${stats.dbDistinct}（唯一索引未拦住，最严重）`,
    );
  }
  if (stats.dbTotal !== stats.totalSuccess) {
    reasons.push(
      `落库不一致：内存成功 ${stats.totalSuccess}，落库 ${stats.dbTotal}（事务提交丢失/回滚未察觉）`,
    );
  }
  if (stats.dbTotal !== expected) {
    reasons.push(`取号总数不符：期望 ${expected}，实际落库 ${stats.dbTotal}（有号被静默吞掉）`);
  }
  if (stats.totalGaps !== 0) {
    reasons.push(`断号 ${stats.totalGaps} 个（序号区间内有空洞，档号被"吃掉"）`);
  }

  return { pass: reasons.length === 0, reasons };
}
