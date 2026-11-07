/**
 * 档号并发压测的序号提取、断号计算与通过判据（硬性验收要点 1）。
 *
 * **本文件刻意零依赖**：不 import 任何 DB / 实体 / Nest 模块，
 * 因此可以被单测直接 import，无需 mock `AppDataSource`。
 *
 * 这拆分不是洁癖：`danghao-concurrency-bench.ts` 顶层 import 了
 * `AppDataSource` 与 TypeORM 实体（带装饰器），直接 import 该文件会在
 * 未初始化 reflect-metadata 时抛 `Cannot read properties of undefined
 * (reading 'constructor')`。判据若与它同处一个模块，就永远测不到。
 *
 * 分层（自上而下，每层都可独立单测）：
 *   1. {@link extractSequenceNumbers} —— 从档号里抠出序号（**失败必须上报，不得静默丢弃**）
 *   2. {@link computeRoundGaps}      —— 由序号算单轮断号数
 *   3. {@link evaluatePass}          —— 由聚合统计量判是否通过
 *
 * 判据的职责边界：
 *   - 只吃**聚合统计量**（`BenchStats`），不吃逐轮明细 —— 明细属诊断信息；
 *   - 只回答「过没过、哪几条没过」，不做 IO、不打印、不退出进程。
 */

/** 档号末段无法解析为序号时，`unparsable` 里保留的原始字符串上限（防日志爆量） */
const UNPARSABLE_SAMPLE_LIMIT = 20;

/**
 * 从单个档号中提取序号。
 *
 * 取最后一个分隔段（`-` 分隔）并按十进制**前缀**解析：
 * `1-2024-A-30-0001-0042` → 42，`…-0042A` → 42（前缀解析，后缀字母被忽略）。
 *
 * @param danghao 完整档号
 * @returns 解析成功返回整数，失败返回 `null`
 */
export function extractSequenceNumber(danghao: string): number | null {
  if (typeof danghao !== 'string' || danghao.length === 0) return null;
  const segments = danghao.split('-');
  const last = segments[segments.length - 1];
  if (last === undefined || last.length === 0) return null;
  const parsed = Number.parseInt(last, 10);
  if (!Number.isFinite(parsed)) return null;
  // parseInt 的前缀解析：'abc' → NaN（正是要抓的失败），'42abc' → 42（可用）
  return parsed;
}

/** {@link extractSequenceNumbers} 的结果 */
export interface SequenceExtraction {
  /** 解析成功的序号，升序 */
  numbers: number[];
  /** 无法解析的档号样本（最多 {@link UNPARSABLE_SAMPLE_LIMIT} 条，仅用于报错提示） */
  unparsable: string[];
  /** 无法解析的档号总数（不受样本上限影响） */
  unparsableCount: number;
  /** 输入档号去重后的总数 */
  total: number;
}

/**
 * 批量提取序号，并**显式上报**解析失败的数量与样本。
 *
 * 为什么不能 `filter(Number.isFinite)` 了事：静默过滤会让 `gaps` 恒为 0，
 * 判据第 6 项永久空转、报告照绿 —— 与 f67a60f 修的「算了但没判」同属
 * 一类「静默空转」，且更难发现（这次连输出里的字都没有）。
 * 因此本函数把失败条数作为**结果的一部分**返回，由判据侧决定如何处理
 * （当前策略：fail-closed，见 {@link evaluatePass} 第 7 项）。
 *
 * 输入先去重：同一档号重复出现属于重号问题，由条件 1/3 判，不该污染 gaps。
 *
 * @param danghaos 档号列表（允许重复）
 */
export function extractSequenceNumbers(danghaos: readonly string[]): SequenceExtraction {
  const unique = new Set(danghaos);
  const numbers: number[] = [];
  const unparsable: string[] = [];
  let unparsableCount = 0;
  for (const danghao of unique) {
    const n = extractSequenceNumber(danghao);
    if (n === null) {
      unparsableCount += 1;
      if (unparsable.length < UNPARSABLE_SAMPLE_LIMIT) unparsable.push(danghao);
    } else {
      numbers.push(n);
    }
  }
  numbers.sort((a, b) => a - b);
  return { numbers, unparsable, unparsableCount, total: unique.size };
}

/** {@link computeRoundGaps} 的结果 */
export interface RoundGaps {
  /** 单轮序号空洞数（`MAX - MIN + 1 - COUNT`），序号不足 2 个时为 0 */
  gaps: number;
  /** 无法解析为序号的档号数 */
  unparsableCount: number;
  /** 无法解析的档号样本（最多 20 条） */
  unparsable: string[];
}

/**
 * 计算单轮断号数（序号区间空洞数）。
 *
 * `gaps = MAX(序号) - MIN(序号) + 1 - COUNT(序号)`。
 * 序号不足 2 个时无法谈「区间」，按 0 处理。
 *
 * **解析失败不计入 gaps 计算**，而是通过 `unparsableCount` 单独上报 ——
 * 二者性质不同，不能混算（混算会让「解析失败」伪装成「无断号」）。
 *
 * @param danghaos 单轮取到的档号列表（允许重复，内部去重）
 */
export function computeRoundGaps(danghaos: readonly string[]): RoundGaps {
  const { numbers, unparsable, unparsableCount } = extractSequenceNumbers(danghaos);
  let gaps = 0;
  if (numbers.length > 1) {
    const min = numbers[0] as number;
    const max = numbers[numbers.length - 1] as number;
    gaps = max - min + 1 - numbers.length;
  }
  return { gaps, unparsableCount, unparsable };
}

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
  /** 各轮无法解析为序号的档号数合计（第 7 项判据） */
  totalUnparsable: number;
}

/** 判据结论 */
export interface BenchVerdict {
  /** 七项判据是否全部满足 */
  pass: boolean;
  /** 未满足的判据说明（pass=true 时为空数组） */
  reasons: string[];
}

/**
 * 档号并发压测的通过判据（**纯函数，无副作用、不依赖 DB**）。
 *
 * 七项判据缺一不可：
 *
 * | # | 条件                           | 含义             | 不满足说明什么               |
 * |---|--------------------------------|------------------|------------------------------|
 * | 1 | totalDuplicate === 0           | 内存层零重号     | 序列自增不是原子的           |
 * | 2 | totalRejected === 0            | 零取号失败       | 锁竞争过激 / 超时            |
 * | 3 | dbTotal === dbDistinct         | 落库后零重号     | 唯一索引没拦住（最严重）     |
 * | 4 | dbTotal === totalSuccess       | 内存与落库数一致 | 事务提交丢失                 |
 * | 5 | dbTotal === concurrency×rounds | 全部取号都拿到了 | 有号被静默吞掉               |
 * | 6 | totalGaps === 0                | 序号区间无空洞   | 序列跳号——档号被"吃掉"       |
 * | 7 | totalUnparsable === 0          | 序号可全部解析   | 末段非纯数字，第 6 项失效    |
 *
 * ## 第 6 项为什么不可省
 *
 * 条件 5 只约束**取号总数**，不约束**序号连续性**。单轮拿到
 * `1,2,3,7,8,…,203` 共 200 个号时，`gaps = 3`（跳过 4/5/6），
 * 但 `dbTotal` 仍凑满——**前五项全绿，档号被"吃掉"却判定通过**。
 * 档号缺号与重号同级严重：编号永久空缺，将来可能被误用或对不上账。
 *
 * ## 第 7 项为什么必须有（fail-closed）
 *
 * 第 6 项依赖「档号末段能解析出序号」。若档号规则配置成以 `ORG` /
 * `RETENTION` 收尾（**模板运行时可变**：`segments` 由 DTO 传入，
 * `volumeSegmentsOnly` 的卷级模板必然去掉 ITEM 段），末段会全部解析失败。
 * 此时若不显式判负，`totalGaps` 是 0，第 6 项**空转通过**，形成
 * 「判据自身有盲区、报告照绿」的假绿。
 *
 * 因此解析失败必须 fail-closed：数量不为 0 即判失败。宁可错杀
 * （真实压测若档号确实带非数字末段，再议序号提取规则——那是数据问题，
 * 不是判据问题），不可放过。
 *
 * ## 为什么用「合计」而不是「逐轮」
 *
 * 每轮 `gaps = MAX - MIN + 1 - COUNT` 恒非负（不同序号数不会超过区间长度），
 * 故「合计为 0」⟺「每轮为 0」。两种写法等价，这里用合计是因为
 * `BenchStats` 只带聚合值——逐轮明细留在调用方的 `rounds[]` 里供诊断输出。
 * 该等价性以「单轮内序号同属一个重置周期」为前提：若将来给压测加入
 * 跨年轮次（`resetCycle=YEAR` 且同轮混取两个年度），序号各自从 1 起，
 * 可能算出负数 —— 届时须改为逐轮 `every` 并重新审视 gaps 定义。
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
  // 第 7 项放在第 6 项之前，保证「gaps 判据本身是否可信」先被说清：
  // 解析全失败时 gaps 恒为 0，第 6 项的"通过"是假象，必须由第 7 项戳穿。
  if (stats.totalUnparsable !== 0) {
    reasons.push(
      `序号解析失败 ${stats.totalUnparsable} 个（档号末段无法解析为序号，疑似末段非纯数字，第 6 项断号判据失效）`,
    );
  }
  if (stats.totalGaps !== 0) {
    reasons.push(`断号 ${stats.totalGaps} 个（序号区间内有空洞，档号被"吃掉"）`);
  }

  return { pass: reasons.length === 0, reasons };
}
