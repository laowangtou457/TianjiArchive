/**
 * 档号并发压测脚本（硬性验收要点 1）。
 *
 * 目标：同一全宗 + 同一年度 + 同一保管期限，N 个并发同时申请档号，
 *       验证「零重号、零断号」（连续整数序列完整）。
 *
 * 用法：
 *   pnpm --filter @tianji/api perf:danghao
 *   CONCURRENCY=200 ROUNDS=10 pnpm --filter @tianji/api perf:danghao
 *
 * 实现说明：
 *   - 直接调用 DanghaoRuleService.generateItemDanghao，与线上著录同一条代码路径
 *     （同样的 scope_key 计算、同样的 `UPDATE ... RETURNING next_value - 1` 原子自增、同样的重试策略）；
 *   - 每个并发在独立事务里取号并写入探针表 perf_danghao_probe（danghao 唯一索引），
 *     只要有重号，唯一约束会立刻抛 23505，脚本捕获并统计；
 *   - 双重校验：内存去重 + 数据库落库去重计数，两者都一致才算通过。
 */
import { AppDataSource } from '../infra/database/data-source';
import { DanghaoRuleService } from '../modules/danghao/rule.service';
import { DanghaoSequenceService } from '../modules/danghao/sequence.service';
import { DanghaoRule } from '../infra/database/entities/danghao-rule.entity';
import { Fonds } from '../infra/database/entities/fonds.entity';
import { OrgNode } from '../infra/database/entities/org-node.entity';
import { Category } from '../infra/database/entities/category.entity';
import { Retention } from '@tianji/shared';
import { evaluatePass } from './danghao-bench-judge';

/** 并发度（同时申请档号的协程数） */
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 100));
/** 轮数 */
const ROUNDS = Math.max(1, Number(process.env.ROUNDS ?? 5));

interface BenchRound {
  round: number;
  success: number;
  rejected: number;
  distinct: number;
  duplicates: string[];
  gaps: number;
  elapsedMs: number;
}


/** 建探针表 */
async function ensureProbeTable(): Promise<void> {
  await AppDataSource.query(`
    CREATE TABLE IF NOT EXISTS perf_danghao_probe (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      danghao    varchar(120) NOT NULL,
      round      int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uk_perf_danghao UNIQUE (danghao)
    )
  `);
}

async function main(): Promise<void> {
  console.log('════════════════ 档号并发压测 ════════════════');
  console.log(`并发度=${CONCURRENCY}，轮数=${ROUNDS}，单轮取号=${CONCURRENCY}`);
  console.log('');

  await AppDataSource.initialize();
  const seqService = new DanghaoSequenceService(AppDataSource);
  const ruleService = new DanghaoRuleService(
    AppDataSource.getRepository(DanghaoRule),
    AppDataSource.getRepository(Fonds),
    AppDataSource.getRepository(OrgNode),
    AppDataSource.getRepository(Category),
    seqService,
  );

  // 使用库中第一个全宗与默认规则（不伪造数据）
  const fondsRow = (await AppDataSource.query(`SELECT id, fonds_no FROM fonds ORDER BY created_at ASC LIMIT 1`)) as Array<{
    id: string;
    fonds_no: string;
  }>;
  if (fondsRow.length === 0) {
    throw new Error('数据库中没有全宗，请先执行 pnpm --filter @tianji/api seed');
  }
  const { id: fondsId, fonds_no: fondsNo } = fondsRow[0];

  const resolved = await ruleService.resolveRule(fondsId, null);
  console.log(
    `全宗：${fondsNo}；档号规则段数 ${resolved.template.segments.length}，重置周期 ${resolved.resetCycle}`,
  );

  await ensureProbeTable();
  await AppDataSource.query('TRUNCATE perf_danghao_probe');

  const year = Number(process.env.BENCH_YEAR ?? new Date().getFullYear());
  const rounds: BenchRound[] = [];
  let totalSuccess = 0;
  let totalRejected = 0;
  let totalDuplicate = 0;

  try {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const started = Date.now();
      const tasks: Array<Promise<string>> = [];

      for (let i = 0; i < CONCURRENCY; i += 1) {
        tasks.push(
          AppDataSource.transaction(async (manager) => {
            const result = await ruleService.generateItemDanghao(manager, {
              fondsId,
              fondsNo,
              categoryId: null,
              year,
              retention: Retention.PERM,
            });
            // 落库：唯一索引是最后一道防线
            await manager.query(
              `INSERT INTO perf_danghao_probe (danghao, round) VALUES ($1, $2)`,
              [result.danghao, round],
            );
            return result.danghao;
          }),
        );
      }

      const settled = await Promise.allSettled(tasks);
      const generated: string[] = [];
      let rejected = 0;
      for (const s of settled) {
        if (s.status === 'fulfilled') generated.push(s.value);
        else {
          rejected += 1;
          console.error(`  ✖ 取号失败：${String(s.reason)}`);
        }
      }

      const uniqueSet = new Set(generated);
      const duplicates = generated.filter((d, i) => generated.indexOf(d) !== i);
      const lastNums = [...uniqueSet]
        .map((d) => Number.parseInt(d.split('-').pop() ?? '0', 10))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
      const gaps = lastNums.length > 1 ? lastNums[lastNums.length - 1] - lastNums[0] + 1 - lastNums.length : 0;
      const elapsedMs = Date.now() - started;

      rounds.push({
        round,
        success: generated.length,
        rejected,
        distinct: uniqueSet.size,
        duplicates: [...new Set(duplicates)],
        gaps,
        elapsedMs,
      });

      totalSuccess += generated.length;
      totalRejected += rejected;
      totalDuplicate += duplicates.length;

      console.log(
        `第 ${round} 轮：成功 ${generated.length}/${CONCURRENCY}，去重 ${uniqueSet.size}，重号 ${duplicates.length}，断号 ${gaps}，拒绝 ${rejected}，耗时 ${elapsedMs}ms`,
      );
    }
  } finally {
    const dbRows = (await AppDataSource.query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT danghao)::int AS distinct FROM perf_danghao_probe`,
    )) as Array<{ total: number; distinct: number }>;
    const dbTotal = Number(dbRows[0]?.total ?? 0);
    const dbDistinct = Number(dbRows[0]?.distinct ?? 0);

    // 断号汇总：各轮 gaps 之和。gaps 定义见单轮计算处
    // （MAX(序号) - MIN(序号) + 1 - COUNT(*)，反映单轮内的序号空洞数）。
    const totalGaps = rounds.reduce((sum, r) => sum + r.gaps, 0);

    console.log('');
    console.log('────────────── 汇总 ──────────────');
    console.log(`申请成功数（内存）：${totalSuccess}`);
    console.log(`落库总数：${dbTotal}，去重后：${dbDistinct}`);
    console.log(`重号数（内存）：${totalDuplicate}；取号失败：${totalRejected}`);
    console.log(`断号数（各轮 gaps 合计）：${totalGaps}`);
    console.log(`理论应落库：${CONCURRENCY * ROUNDS}`);

    // 判据逻辑集中在纯函数 evaluatePass 里（可单测、可读、无 DB 依赖）。
    // 此处只负责把统计量喂进去、把结论打印出来。
    const verdict = evaluatePass({
      totalDuplicate,
      totalRejected,
      dbTotal,
      dbDistinct,
      totalSuccess,
      concurrency: CONCURRENCY,
      rounds: ROUNDS,
      totalGaps,
    });

    console.log('');
    if (verdict.pass) {
      console.log('IS_PASS: YES —— 并发取号零重号、零断号，序列连续，全部落库成功');
    } else {
      console.log('IS_PASS: NO —— 存在重号/断号/丢号/落库不一致，请检查序列实现与唯一约束');
      // 1) 逐项判据失败原因（判定层，说明"哪条闸门没过"）
      for (const reason of verdict.reasons) {
        console.log(`  ✖ 判据未满足：${reason}`);
      }
      // 2) 逐轮明细（诊断层，说明"具体是哪一轮、哪个档号"）
      for (const r of rounds.filter((x) => x.duplicates.length > 0)) {
        console.log(`  第 ${r.round} 轮重号：${r.duplicates.join(', ')}`);
      }
      for (const r of rounds.filter((x) => x.gaps > 0)) {
        console.log(`  第 ${r.round} 轮断号：gaps=${r.gaps}（序号区间内有空洞）`);
      }
      process.exitCode = 1;
    }

    await AppDataSource.query('DROP TABLE IF EXISTS perf_danghao_probe').catch(() => undefined);
    await AppDataSource.destroy();
  }
}

main().catch(async (err: Error) => {
  console.error(`✖ 压测失败：${err.message}`);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
