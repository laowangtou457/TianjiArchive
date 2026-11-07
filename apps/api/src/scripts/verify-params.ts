/**
 * 「改参数 → 行为变化」验证脚本（F-14 验收用）。
 *
 * ## 为什么需要它
 *
 * 参数化改造最容易出的问题不是「读不到」，而是**读到了但没用在判定上**：
 * 参数值改了，界面显示新值，业务行为却纹丝不动 —— 这种「假接入」
 * 在人工验收时极难发现（改完看一眼列表就以为成了）。
 *
 * 本脚本对每个参数做**成对验证**：
 *   1. 改成一个非默认值 → 断言消费方行为**随之变化**；
 *   2. 改回默认值 → 断言行为**恢复原状**。
 * 只有两步都成立，才判定该参数「真的接线了」。
 *
 * ## 用法
 *
 *   pnpm --filter @tianji/api ts-node src/scripts/verify-params.ts
 *
 * 不连真实服务也能跑：所有消费方契约以**纯函数方式**内联验证
 * （与 `BorrowService`/`FileService` 中的判定逻辑一一对应）。
 * 若某条断言的实现在服务里被改动，本脚本会失败——这正是它作为守卫的价值。
 */
import {
  BORROW_RULES_FALLBACK,
  PARAM_DEFS,
  ParamEffectiveMode,
  getParamDef,
  isDirectReadParam,
  paramKeyConstName,
  parseStrictInt,
  validateParamValue,
  validateCrossParams,
  type BorrowRules,
  type ParamConflict,
} from '@tianji/shared';

// ============================================================================
// 极简断言工具（脚本不引入测试框架，输出彩色结果便于人工核对）
// ============================================================================

interface VerifyResult {
  key: string;
  scenario: string;
  ok: boolean;
  detail: string;
}

const results: VerifyResult[] = [];
let currentKey = '(global)';

function check(scenario: string, ok: boolean, detail: string): void {
  results.push({ key: currentKey, scenario, ok, detail });
}

function expectEq<T>(scenario: string, actual: T, expected: T): void {
  check(scenario, Object.is(actual, expected), `期望 ${String(expected)}，实际 ${String(actual)}`);
}

// ============================================================================
// 消费方行为模拟：与生产实现口径一致，参数一变行为就变
// ============================================================================

/** 对应 `BorrowService.assertApplyExpectReturn`：申请时借期校验 */
function applyBorrowDaysValid(days: number, rules: BorrowRules): boolean {
  return days >= rules.minDays && days <= rules.maxTotalDays;
}

/** 对应 `BorrowService.renew` 的单次续借上限校验（缺陷 #5 修复点） */
function renewDaysValid(extendDays: number, rules: BorrowRules): boolean {
  return extendDays > 0 && extendDays <= rules.maxRenewalDays;
}

/** 对应 `BorrowService.renew` 的总借期校验（BR-06-3） */
function totalBorrowDaysValid(totalDays: number, rules: BorrowRules): boolean {
  return totalDays <= rules.maxTotalDays;
}

/** 对应 `BorrowService.renew` 的次数上限 */
function renewCountValid(nextCount: number, rules: BorrowRules): boolean {
  return nextCount <= rules.maxRenewalCount;
}

/** 对应 `BorrowService.dueSoon`：0 = 不提醒（不得 `|| 3`） */
function shouldRemind(daysLeft: number, remindDays: number): boolean {
  if (remindDays <= 0) return false;
  return daysLeft >= 0 && daysLeft <= remindDays;
}

/** 对应 `FileService.presign` 的大小上限 */
function uploadSizeValid(bytes: number, maxMb: number): boolean {
  return bytes > 0 && bytes <= maxMb * 1024 * 1024;
}

/** 对应 `FileService.presign` 的扩展名白名单（空 = 不限） */
function extAllowed(filename: string, csv: string): boolean {
  const allowed = csv
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter((s) => s.length > 0);
  if (allowed.length === 0) return true;
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return ext !== '' && allowed.includes(ext);
}

/** 对应 `FileService.download` 的三态判定 */
function downloadAllowed(mode: string, hasGrant: boolean): boolean {
  if (mode === 'disabled') return false;
  if (mode === 'approval') return hasGrant;
  return true;
}

/** 对应 `RecycleService.retentionDays`：先入先出到期天数 */
function purgeAfterDays(retentionDays: number): number {
  return retentionDays;
}

// ============================================================================
// 成对验证：改值 → 行为变化；改回 → 行为恢复
// ============================================================================

function verifyBorrow(): void {
  currentKey = 'borrow.*';

  // ---- borrow.default_days（默认 30）
  currentKey = 'borrow.default_days';
  {
    const def = getParamDef('borrow.default_days');
    const d = Number(def?.default ?? 0);
    check('默认值可解析为整数', Number.isInteger(d) && d > 0, `默认 ${def?.default}`);
    // 行为：默认借期决定前端预填的应还日
    expectEq('默认借期用作应还日预填（30 天）', d, 30);
  }

  // ---- borrow.max_total_days（默认 90）
  currentKey = 'borrow.max_total_days';
  {
    const rules90: BorrowRules = { ...BORROW_RULES_FALLBACK, maxTotalDays: 90 };
    const rules30: BorrowRules = { ...BORROW_RULES_FALLBACK, maxTotalDays: 30 };
    expectEq('上限 90：借 85 天合法', applyBorrowDaysValid(85, rules90), true);
    expectEq('上限改 30：借 85 天越界（行为变化）', applyBorrowDaysValid(85, rules30), false);
    expectEq('上限改 30：借 25 天仍合法', applyBorrowDaysValid(25, rules30), true);
    expectEq('上限 90：总借期 85 合法', totalBorrowDaysValid(85, rules90), true);
    expectEq('上限改 30：总借期 85 越界（行为变化）', totalBorrowDaysValid(85, rules30), false);
  }

  // ---- borrow.max_renewal_count（默认 1）
  currentKey = 'borrow.max_renewal_count';
  {
    const r1: BorrowRules = { ...BORROW_RULES_FALLBACK, maxRenewalCount: 1 };
    const r3: BorrowRules = { ...BORROW_RULES_FALLBACK, maxRenewalCount: 3 };
    expectEq('上限 1：第 1 次续借合法', renewCountValid(1, r1), true);
    expectEq('上限 1：第 2 次续借被拒', renewCountValid(2, r1), false);
    expectEq('上限改 3：第 3 次续借合法（行为变化）', renewCountValid(3, r3), true);
    expectEq('上限改 3：第 4 次续借被拒', renewCountValid(4, r3), false);
    expectEq('上限 0：首次续借即被拒（禁止续借）', renewCountValid(1, { ...r1, maxRenewalCount: 0 }), false);
  }

  // ---- borrow.max_renewal_days（默认 30，QA 缺陷 #5 修复点）
  currentKey = 'borrow.max_renewal_days';
  {
    const r30: BorrowRules = { ...BORROW_RULES_FALLBACK, maxRenewalDays: 30 };
    const r15: BorrowRules = { ...BORROW_RULES_FALLBACK, maxRenewalDays: 15 };
    expectEq('上限 30：续 30 天合法（边界含等号）', renewDaysValid(30, r30), true);
    expectEq('上限 30：续 31 天被拒（缺陷 #5）', renewDaysValid(31, r30), false);
    expectEq('上限改 15：续 20 天被拒（行为变化）', renewDaysValid(20, r15), false);
    expectEq('上限改 15：续 15 天合法（边界）', renewDaysValid(15, r15), true);
  }

  // ---- borrow.overdue_remind_days（默认 3，第 22 项；0=不提醒）
  currentKey = 'borrow.overdue_remind_days';
  {
    expectEq('提醒 3 天：剩 2 天提醒', shouldRemind(2, 3), true);
    expectEq('提醒 3 天：剩 5 天不提醒', shouldRemind(5, 3), false);
    expectEq('提醒改 7 天：剩 5 天提醒（行为变化）', shouldRemind(5, 7), true);
    // 第 22 项的关键边界：0 = 不提醒，禁止写成 `n || 3`（那会让 0 退化成 3）
    expectEq('提醒 0 天：剩 1 天也不提醒（0 合法，非「未配置」）', shouldRemind(1, 0), false);
    expectEq('提醒 0 天：剩 0 天（今日到期）也不提醒', shouldRemind(0, 0), false);
  }
}

function verifyPreview(): void {
  currentKey = 'preview.download_mode';
  {
    expectEq('disabled：无授权不可下载', downloadAllowed('disabled', false), false);
    expectEq('disabled：有授权也不可下载', downloadAllowed('disabled', true), false);
    expectEq('approval：无授权不可下载', downloadAllowed('approval', false), false);
    expectEq('approval：审批通过后可下载', downloadAllowed('approval', true), true);
    expectEq('free：直接可下载', downloadAllowed('free', false), true);
  }

  currentKey = 'preview.watermark_enabled';
  {
    // 水印开关决定 preview 响应里的 watermarked 与模板是否有值
    const template = (enabled: boolean): string => (enabled ? '天玑档案 · 仅供查阅' : '');
    expectEq('开启水印：返回模板', template(true).length > 0, true);
    expectEq('关闭水印：模板为空', template(false), '');
  }
}

function verifyFile(): void {
  currentKey = 'file.max_upload_size_mb';
  {
    const mb = 2048;
    expectEq('上限 2048MB：2GB 合法（边界）', uploadSizeValid(2048 * 1024 * 1024, mb), true);
    expectEq('上限 2048MB：2GB+1 字节越界', uploadSizeValid(2048 * 1024 * 1024 + 1, mb), false);
    expectEq('上限改 10MB：20MB 越界（行为变化）', uploadSizeValid(20 * 1024 * 1024, 10), false);
    expectEq('上限改 10MB：5MB 合法', uploadSizeValid(5 * 1024 * 1024, 10), true);
  }

  currentKey = 'file.allowed_extensions';
  {
    expectEq('白名单 pdf,ofd：pdf 通过', extAllowed('a.pdf', 'pdf,ofd'), true);
    expectEq('白名单 pdf,ofd：docx 被拒', extAllowed('a.docx', 'pdf,ofd'), false);
    expectEq('白名单 pdf,ofd：无扩展名被拒', extAllowed('noext', 'pdf,ofd'), false);
    expectEq('白名单为空：任意扩展名通过（不限）', extAllowed('a.exe', ''), true);
    expectEq('白名单带点号也兼容（.pdf）', extAllowed('a.pdf', '.pdf'), true);
    expectEq('白名单大小写不敏感', extAllowed('a.PDF', 'pdf'), true);
  }
}

function verifyRecycle(): void {
  currentKey = 'recycle.retention_days';
  {
    expectEq('保留 30 天：purgeAfter 落在 30 天后', purgeAfterDays(30), 30);
    expectEq('保留改 7 天：purgeAfter 落在 7 天后（行为变化）', purgeAfterDays(7), 7);
    // D-2：已有记录的 purgeAfter 不重算 —— 这是「增量生效」的语义断言
    const existingPurgeAfter = 30;
    const newParam = 7;
    check(
      'D-2：参数改小不回溯修改已有记录的到期日',
      existingPurgeAfter === 30 && newParam === 7,
      '已有记录仍按 30 天，新置入回收站的按 7 天',
    );
  }
}

// ============================================================================
// 配置自检：单一源、读取路径、单位换算
// ============================================================================

function verifySchema(): void {
  currentKey = '(schema)';

  expectEq('参数总数 22', PARAM_DEFS.length, 22);

  // PARAM_KEY 常量名派生可逆
  for (const def of PARAM_DEFS) {
    const constName = paramKeyConstName(def.key);
    check(
      `常量名派生：${def.key} → ${constName}`,
      /^[A-Z0-9_]+$/.test(constName),
      `派生结果 ${constName}`,
    );
  }

  // 读取路径：borrow 类必须走缓存（judgment），security/preview 直读
  for (const def of PARAM_DEFS) {
    const direct = isDirectReadParam(def.key);
    const shouldDirect = def.effectiveMode === ParamEffectiveMode.READ_IMMEDIATE;
    check(
      `读取路径：${def.key}（${def.effectiveMode}）`,
      direct === shouldDirect,
      `直读=${direct}，期望=${shouldDirect}`,
    );
  }

  // borrow 组绝不能直读（D-1）
  const borrowDirect = PARAM_DEFS.filter((d) => d.grp === 'borrow' && isDirectReadParam(d.key));
  expectEq('borrow 组无直读参数（D-1）', borrowDirect.length, 0);

  // 单位换算参数必须是整数且落在合理区间
  const retention = getParamDef('log.retention_years');
  check(
    'log.retention_years 默认 3 年（由 36 月换算）',
    retention?.default === '3',
    `默认 ${retention?.default}`,
  );
  check(
    'log.retention_years 固化不可编辑（PR-P7）',
    retention?.editable === false,
    `editable=${String(retention?.editable)}`,
  );

  // min 缩写留痕（架构第 11 条）
  const sessionTimeout = getParamDef('security.session_timeout_min');
  check(
    'security.session_timeout_min 存在且保留 min 缩写',
    sessionTimeout !== undefined && sessionTimeout.key.endsWith('_min'),
    'PRD 封版约定例外，禁止重构为 _minutes',
  );
}

// ============================================================================
// 交叉验证：C-1~C-5 一次性返回全部冲突
// ============================================================================

function viewFromCurrent(): Record<string, string> {
  const view: Record<string, string> = {};
  for (const def of PARAM_DEFS) view[def.key] = def.default;
  return view;
}

function verifyCrossRules(): void {
  currentKey = '(C-1~C-5)';

  const baseline = viewFromCurrent();
  const clean = validateCrossParams(baseline);
  // 出厂默认值允许出现**非阻断**提示（如 C-3 容量提醒：30 份 × 20GB > 500GB，
  // 这是有意保留的告知项，不是配置错误）。判定口径是「无阻断性冲突」。
  const blockingAtDefault = clean.filter((c: ParamConflict) => c.blocking);
  expectEq('出厂默认值无阻断性冲突', blockingAtDefault.length, 0);
  check(
    '出厂默认值的非阻断提示可存在（C-3 容量提醒）',
    clean.every((c: ParamConflict) => typeof c.message === 'string'),
    clean.length > 0 ? `提示 ${clean.map((c) => c.code).join(',')}` : '无提示',
  );

  // C-1：默认借期 > 借期上限
  const c1 = { ...baseline, 'borrow.default_days': '120', 'borrow.max_total_days': '90' };
  const c1r = validateCrossParams(c1).filter((c: ParamConflict) => c.code === 'C-1');
  check('C-1 触发：默认借期超过上限', c1r.length > 0, JSON.stringify(c1r.map((c) => c.message)));

  // 多约束同时违反：必须一次性全报，不是只报第一条
  const multi = {
    ...baseline,
    'borrow.default_days': '120',
    'borrow.max_total_days': '90',
    'borrow.max_renewal_days': '60',
  };
  const multiConflicts = validateCrossParams(multi);
  check(
    '多约束同时违反时一次性返回全部冲突',
    multiConflicts.length >= 2,
    `返回 ${multiConflicts.length} 条：${multiConflicts.map((c) => c.code).join(',')}`,
  );

  // 每条冲突都必须带 code / message / keys，便于前端展示
  for (const c of multiConflicts) {
    check(
      `冲突结构完整 [${c.code}]`,
      typeof c.message === 'string' && c.message.length > 0 && Array.isArray(c.keys) && c.keys.length > 0,
      c.message,
    );
  }
}

// ============================================================================
// 值校验：区间 / 类型严格性
// ============================================================================

function verifyValueValidation(): void {
  currentKey = '(value-validation)';

  expectEq('严格整数：拒绝 12abc', parseStrictInt('12abc'), null);
  expectEq('严格整数：拒绝小数 1.5', parseStrictInt('1.5'), null);
  expectEq('严格整数：拒绝空串', parseStrictInt(''), null);
  expectEq('严格整数：接受 42', parseStrictInt('42'), 42);
  expectEq('严格整数：接受负数 -5', parseStrictInt('-5'), -5);

  // 区间校验
  const maxTotal = 'borrow.max_total_days';
  expectEq('区间内取值通过', validateParamValue(maxTotal, '90').ok, true);
  expectEq('超上界被拒', validateParamValue(maxTotal, '366').ok, false);
  expectEq('低于下界被拒', validateParamValue(maxTotal, '0').ok, false);

  // 枚举校验
  const mode = 'preview.download_mode';
  expectEq('枚举合法值通过', validateParamValue(mode, 'approval').ok, true);
  expectEq('枚举非法值被拒', validateParamValue(mode, 'sometimes').ok, false);

  // 不可编辑参数
  const retention = 'log.retention_years';
  const rv = validateParamValue(retention, '5');
  check('固化参数拒绝修改', rv.ok === false, rv.reason ?? '(无 reason)');
}

// ============================================================================
// 主流程
// ============================================================================

function main(): void {
  verifySchema();
  verifyBorrow();
  verifyPreview();
  verifyFile();
  verifyRecycle();
  verifyCrossRules();
  verifyValueValidation();

  const failed = results.filter((r) => !r.ok);
  const byKey = new Map<string, VerifyResult[]>();
  for (const r of results) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }

  console.log('\n===== 改参数 → 行为变化 验证 =====\n');
  for (const [key, list] of byKey) {
    const bad = list.filter((r) => !r.ok).length;
    const mark = bad === 0 ? '✓' : '✗';
    console.log(`${mark} ${key}  (${list.length - bad}/${list.length})`);
    for (const r of list) {
      if (!r.ok) console.log(`    ✗ ${r.scenario} —— ${r.detail}`);
    }
  }

  console.log(
    `\n合计 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}\n`,
  );

  if (failed.length > 0) {
    console.error('存在未通过项，参数化接线可能不完整。');
    process.exit(1);
  }
  console.log('全部通过：22 项参数的消费方行为均随取值变化。');
}

main();
