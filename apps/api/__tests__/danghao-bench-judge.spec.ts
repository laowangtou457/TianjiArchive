/**
 * 档号并发压测通过判据（evaluatePass）单测 —— 硬性验收要点 1 的判据回归。
 *
 * 背景：判据曾只有五项，「跳号但凑满总数」能全绿假通过（f67a60f 修复，
 * 第 6 项 totalGaps === 0 纳入）。本文件钉住六项判据各自的独立失败模式，
 * 防止判据被改回去。
 *
 * 为什么测纯函数而非脚本：`danghao-concurrency-bench.ts` 顶层 import
 * TypeORM 实体（装饰器），import 即炸；判据已按可测试性拆分为零依赖的
 * `danghao-bench-judge.ts`（b62bd1f）。这是「断言对象必须在生产路径上」
 * 的结构化解法 —— 单测测的就是 main() 实际调用的同一个函数。
 */
import { describe, expect, it } from 'vitest';
import {
  computeRoundGaps,
  evaluatePass,
  extractSequenceNumber,
  type BenchStats,
} from '@api/scripts/danghao-bench-judge';

/** 正常场景的聚合统计量：并发 200 × 10 轮 = 2000 号，全连续、零重号、零失败、零解析失败 */
function okStats(over: Partial<BenchStats> = {}): BenchStats {
  return {
    totalDuplicate: 0,
    totalRejected: 0,
    dbTotal: 2000,
    dbDistinct: 2000,
    totalSuccess: 2000,
    concurrency: 200,
    rounds: 10,
    totalGaps: 0,
    totalUnparsable: 0,
    ...over,
  };
}

describe('evaluatePass｜档号压测通过判据', () => {
  it('正常场景：pass=true 且 reasons 为空', () => {
    const v = evaluatePass(okStats());
    expect(v.pass).toBe(true);
    expect(v.reasons, '通过时不应有任何未满足项').toEqual([]);
  });

  it('【f67a60f 反例】跳号凑满总数：gaps=3 必须 NO（第 6 项不可省）', () => {
    // 历史漏洞现场：单轮拿到 1,2,3,7,8,…,203 共 200 个号，gaps=3，
    // 但 dbTotal 仍凑满 2000 —— 旧五项判据全绿误判通过。
    const v = evaluatePass(okStats({ totalGaps: 3 }));
    expect(v.pass, '跳号与重号同级严重，不得通过').toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0], '未过项必须指向断号，而非其他判据').toContain('断号');
    expect(v.reasons[0]).toContain('3');
  });

  it('重号：totalDuplicate=5 → NO，仅触发重号一项', () => {
    const v = evaluatePass(okStats({ totalDuplicate: 5 }));
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain('重号');
  });

  it('取号失败：totalRejected=2 → NO，仅触发取号失败一项', () => {
    const v = evaluatePass(okStats({ totalRejected: 2 }));
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain('取号失败');
  });

  it('落库重号：dbTotal≠dbDistinct → NO（唯一索引失守，最严重）', () => {
    const v = evaluatePass(okStats({ dbDistinct: 1995 }));
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain('落库重号');
  });

  it('落库缺 10：同时触发「落库不一致」+「总数不符」两条（同源但独立约束）', () => {
    // 内存取到 2000，落库只有 1990：条件 4（≠totalSuccess）与条件 5（≠期望总数）同红。
    const v = evaluatePass(okStats({ dbTotal: 1990, dbDistinct: 1990 }));
    expect(v.pass).toBe(false);
    expect(v.reasons, '两条判据各自独立，应各报一条').toHaveLength(2);
    expect(v.reasons.join()).toContain('落库不一致');
    expect(v.reasons.join()).toContain('取号总数不符');
  });

  it('多重失败：七项全不满足 → 7 条 reasons，无遗漏', () => {
    const v = evaluatePass(
      okStats({
        totalDuplicate: 1,
        totalRejected: 1,
        dbTotal: 1999,
        dbDistinct: 1998,
        totalSuccess: 2000,
        totalGaps: 1,
        totalUnparsable: 1,
      }),
    );
    expect(v.pass).toBe(false);
    expect(v.reasons, '七项判据应全部报出，供一次性诊断').toHaveLength(7);
  });

  it('防御：负 gaps 也不得通过（钉住 !==0 而非 >0 才拦的写法）', () => {
    // 负 gaps 当前构造不出来的真正防线是「压测脚本 BENCH_YEAR 全程固定，
    // 同轮内跨年重置不可能发生」，而非定义上恒非负。若未来压测支持跨年
    // 轮次（resetCycle=YEAR 混入两个年度的序号），本条应变红——届时根因
    // 在压测工具不适用于跨年重置规则，**不在判据**，排查时勿改错方向。
    const v = evaluatePass(okStats({ totalGaps: -2 }));
    expect(v.pass, '负 gaps 是异常输入，必须拒绝而非放行').toBe(false);
    expect(v.reasons[0]).toContain('断号');
  });

  it('第 7 项：序号解析失败必须 NO（reasons 恰 1 条，指明解析失败与数量）', () => {
    const v = evaluatePass(okStats({ totalUnparsable: 3 }));
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain('序号解析失败');
    expect(v.reasons[0]).toContain('3');
  });

  it('第 7 项关键性质：解析全失败 + gaps=0 也必须 NO（真实空转原型）', () => {
    // 隐患原型（工程师实测矩阵 ⑥ 号场景）：档号末段纯字母时序号提取为 0，
    // gaps 恒为 0 —— 若只有第 6 项，报告会显示「零断号」假通过。
    // 第 7 项的存在就是戳穿这个伪装：gaps 不可信时必须显式拒绝。
    const v = evaluatePass(okStats({ totalUnparsable: 2000, totalGaps: 0 }));
    expect(v.pass, '「零断号」在判据失效时不构成通过').toBe(false);
    expect(v.reasons[0]).toContain('序号解析失败');
  });

  it('边界：期望总数由 concurrency×rounds 计算，不同参数组合各自正确', () => {
    expect(evaluatePass(okStats({ concurrency: 50, rounds: 4, dbTotal: 200, dbDistinct: 200, totalSuccess: 200 })).pass).toBe(true);
    // 同参数下少 1 号 → NO
    expect(evaluatePass(okStats({ concurrency: 50, rounds: 4, dbTotal: 199, dbDistinct: 199, totalSuccess: 200 })).pass).toBe(false);
  });
});

describe('extractSequenceNumber｜档号末段序号提取', () => {
  it('正常纯数字末段 → 提取序号', () => {
    expect(extractSequenceNumber('1-2024-A-30-0001-0042')).toBe(42);
  });

  it('末段带字母后缀 → 前缀解析得序号（`0042A` → 42，**不是** NaN）', () => {
    // 工程师曾误判此场景为 NaN——`parseInt` 是前缀解析，后缀字母被忽略。
    // 本用例钉住实测行为，防同类「想当然」误判复发。
    expect(extractSequenceNumber('1-2024-A-30-0001-0042A')).toBe(42);
  });

  it('末段纯字母 → null（序号不在末段，第 6 项失效的源头场景）', () => {
    expect(extractSequenceNumber('1-2024-A')).toBeNull();
  });

  it('空字符串 → null', () => {
    expect(extractSequenceNumber('')).toBeNull();
  });
});

describe('computeRoundGaps｜单轮断号计算', () => {
  it('正例：跳号被正确抓出（001,002,004 → gaps=1）', () => {
    const r = computeRoundGaps(['1-2024-A-30-0001-001', '1-2024-A-30-0001-002', '1-2024-A-30-0001-004']);
    expect(r.gaps).toBe(1);
    expect(r.unparsableCount).toBe(0);
  });

  it('反例：解析失败不污染 gaps（失败单独计数，gaps 只按可解析序号算）', () => {
    // 「解析失败」与「断号」性质不同不可混算：混算会让解析失败伪装成断号，
    // 或反向让 gaps 被失真数据污染。二者必须分开上报。
    const r = computeRoundGaps(['1-2024-A-30-0001-001', '1-2024-A', '1-2024-A-30-0001-002']);
    expect(r.gaps, '可解析的 2 个序号连续，gaps 应为 0').toBe(0);
    expect(r.unparsableCount).toBe(1);
    expect(r.unparsable).toEqual(['1-2024-A']);
  });

  it('去重：重复档号不参与 gaps 计算（001,001,002 → gaps=0）', () => {
    const r = computeRoundGaps(['x-001', 'x-001', 'x-002']);
    expect(r.gaps).toBe(0);
  });
});
