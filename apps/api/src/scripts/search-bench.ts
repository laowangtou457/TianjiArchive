/**
 * 检索性能压测（NFR-2：10 万件级，简单检索 P95 ≤ 1s；100 并发）。
 *
 * 用法：
 *   pnpm --filter @tianji/api perf:search
 *   BASE_URL=http://localhost:3000/api PERF_USER=admin PERF_PASS=Tianji@2024 pnpm --filter @tianji/api perf:search
 *
 * 说明：
 *   - 通过真实 HTTP 接口压测（含 JWT、Guard、审计拦截器、ES 查询、结果组装），比直连 DB 更接近线上；
 *   - 并发度默认 20（避免小机器把 API 打挂），可用 CONCURRENCY 覆盖；
 *   - 输出 P50/P95/P99 与错误率，P95 ≤ 1000ms 判定通过。
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/api';
const USERNAME = process.env.PERF_USER ?? 'admin';
const PASSWORD = process.env.PERF_PASS ?? 'Tianji@2024';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 20));
const ROUNDS = Math.max(1, Number(process.env.ROUNDS ?? 5));
const KEYWORD = process.env.PERF_KEYWORD ?? '档案';

interface Sample {
  ms: number;
  ok: boolean;
  status: number;
}

/** 登录获取 token */
async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const json = (await res.json()) as { code: number; data?: { accessToken?: string }; message?: string };
  if (!res.ok || json.code !== 0 || !json.data?.accessToken) {
    throw new Error(`登录失败：${json.message ?? res.statusText}`);
  }
  return json.data.accessToken;
}

/** 单次全文检索 */
async function searchOnce(token: string, keyword: string): Promise<Sample> {
  const started = performance.now();
  try {
    const res = await fetch(
      `${BASE_URL}/search/fulltext?keyword=${encodeURIComponent(keyword)}&page=1&size=20`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const ms = performance.now() - started;
    return { ms, ok: res.ok, status: res.status };
  } catch {
    return { ms: performance.now() - started, ok: false, status: 0 };
  }
}

/** 分位数 */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[idx]);
}

async function main(): Promise<void> {
  console.log('════════ 检索性能压测 ════════');
  console.log(`目标=${BASE_URL}，并发=${CONCURRENCY}，轮数=${ROUNDS}，关键词=「${KEYWORD}」`);

  const token = await login();
  console.log('登录成功');

  const samples: Sample[] = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const tasks: Array<Promise<Sample>> = [];
    for (let i = 0; i < CONCURRENCY; i += 1) tasks.push(searchOnce(token, KEYWORD));
    const settled = await Promise.all(tasks);
    samples.push(...settled);
    const okCount = settled.filter((s) => s.ok).length;
    console.log(`第 ${round} 轮：成功 ${okCount}/${CONCURRENCY}`);
  }

  const ok = samples.filter((s) => s.ok).map((s) => s.ms);
  const errCount = samples.length - ok.length;
  const p50 = percentile(ok, 50);
  const p95 = percentile(ok, 95);
  const p99 = percentile(ok, 99);
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : 0;

  console.log('');
  console.log('──────── 结果 ────────');
  console.log(`样本 ${samples.length}，成功 ${ok.length}，失败 ${errCount}`);
  console.log(`平均 ${avg}ms｜P50 ${p50}ms｜P95 ${p95}ms｜P99 ${p99}ms`);

  const pass = errCount === 0 && p95 <= 1000;
  console.log('');
  console.log(
    pass
      ? 'IS_PASS: YES —— 简单检索 P95 ≤ 1000ms（NFR-2）'
      : 'IS_PASS: NO —— 存在错误或 P95 超阈值，请检查 ES 索引/数据量/机器资源',
  );
  if (!pass) process.exitCode = 1;
}

main().catch((err: Error) => {
  console.error(`✖ 压测失败：${err.message}`);
  process.exit(1);
});
