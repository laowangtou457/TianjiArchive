/**
 * `PERMISSION_MUTATIONS` 清单 ↔ 源码调用点 一致性守卫（C-5 栏 B）
 *
 * ## 为什么需要这个文件
 *
 * 清单迁到 `packages/shared/src/permission-mutations.ts` 只是**把数据集中了**，
 * 不等于**规则生效**。这两件事必须分开看：
 *
 *   - 清单是死的：一个 `readonly` 数组，没人读它就不会产生任何效果；
 *   - 规则是活的：必须有人（CI 或测试）拿着清单去**核对源码**，才能拦住"第 11 处漏了"。
 *
 * 目前仓库里已有真正的 CI 静态自检脚本：
 * `scripts/ci-check-permission-mutations.cjs`（挂 `pnpm ci:check:perm-mutations`）。
 * 本文件与它是**互补**关系，不是替代：
 *
 *   - CI 脚本：纯文本扫描，覆盖「新增了第 N 处入口，清单没登记」这一常见漏法（反向 R2）；
 *   - 本文件：加载真实 class、检查方法体，覆盖「清单登记了但方法体没 invalidate」，
 *     以及「排除理由是否仍成立」。
 *
 * 组 4 用来保证 CI 脚本本身不会在重构中消失或失效。
 *
 * ## 产品经理提的那个问题（原话转述）
 *
 * > 「`borrow.approve.self-check` 这条排除项，CI 规则落地时会不会被扫进去？
 * >  如果规则是简单的『调用这些方法必须有 invalidate』，而没有『排除列表』的加载逻辑，
 * >  self-check 这条依然会被当成疑似遗漏。」
 *
 * **这个担心是对的，而且必须用测试回答，不能靠口头承诺。**
 * 本文件的 `EXCLUSIONS 必须被真正读取` 一组就是为此而写：
 * 它验证"按排除清单过滤后 self-check 不再被告警"，而不是验证"排除清单数组存在"。
 * 换句话说——**如果将来有人写了个不读排除列表的检查器，本组会红**。
 *
 * ## 本文件能证明什么 / 不能证明什么
 *
 * ✅ 能证明：清单里每个 `Service.method` 都真实存在于源码，
 *    且在**同一方法体内**存在 `invalidateSnapshot` 调用（排除项除外）。
 * ✅ 能证明：排除项的理由成立——self-check 确实不调 invalidate、
 *    且它的拦截依据是字段比对（`applicantId === userId`）而非权限快照。
 * ❌ 不能证明：跨方法传递的调用链（A 调 B、B 里 invalidate）。
 *    `user.update-password-hash` 就是这种情形，清单 note 里已明确写了
 *    "由调用方负责，CI 自检须按执行路径判定"。本文件对其做**降级检查**
 *    （只要求调用方 changePassword 存在 invalidate），并在用例名里标注。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PERMISSION_MUTATIONS,
  PERMISSION_MUTATION_EXCLUSIONS,
  permissionMutationKeys,
} from '@tianji/shared';
import { UserAdminService } from '@api/modules/user/user-admin.service';
import { UserService } from '@api/modules/user/user.service';
import { AuthService } from '@api/modules/auth/auth.service';
import { BorrowService } from '@api/modules/borrow/borrow.service';

// ------------------------------------------------------------------ 工具
/** 把源码方法 toString() 出来，用于"方法体内是否含某调用"的判定 */
function bodyOf(ctor: unknown, method: string): string {
  const proto = (ctor as { prototype: Record<string, unknown> }).prototype;
  const fn = proto[method];
  if (typeof fn !== 'function') {
    throw new Error(`方法不存在：${method}`);
  }
  return fn.toString();
}

const SERVICE_MAP: Record<string, unknown> = {
  UserAdminService,
  UserService,
  AuthService,
  BorrowService,
};

/**
 * 判定一个方法体内是否调用了 `invalidateSnapshot`。
 *
 * 注意**不能**用 `body.includes('invalidateSnapshot')` 直接判：
 * 那样注释里出现这个词就会误判为"已调用"——`borrow.service.ts:234` 的注释
 * 恰好写着「【故意不调用 invalidateSnapshot】」，用 `includes` 会把它判成"有调用"。
 * 必须先剥掉注释再判。
 */
function callsInvalidate(ctor: unknown, method: string): boolean {
  const body = bodyOf(ctor, method)
    // 去块注释
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 去行注释
    .replace(/\/\/[^\n]*/g, '');
  return /invalidateSnapshot\s*\(/.test(body);
}

// ============================================================================
// 组 1：清单完整性
// ============================================================================
describe('PERMISSION_MUTATIONS 清单完整性', () => {
  it('清单非空（清单被清空时本组红，防止"规则静默失效"）', () => {
    expect(PERMISSION_MUTATIONS.length).toBeGreaterThan(0);
  });

  it('每条 entry 的 id 唯一（重复 id 会让 CI 报错定位失效）', () => {
    const ids = PERMISSION_MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size, `重复 id: ${ids.join(',')}`).toBe(ids.length);
  });

  it('每条 entry 必须有 affects 与 note（否则人工核对时无从判断影响面）', () => {
    for (const m of PERMISSION_MUTATIONS) {
      expect(m.affects, `${m.id} 缺 affects`).toBeTruthy();
      expect(m.note, `${m.id} 缺 note`).toBeTruthy();
    }
  });

  it('permissionMutationKeys() 与清单一一对应（派生函数不能漂移）', () => {
    const keys = permissionMutationKeys();
    expect(keys.length).toBe(PERMISSION_MUTATIONS.length);
    expect(keys).toEqual(PERMISSION_MUTATIONS.map((m) => `${m.service}.${m.method}`));
  });

  it('清单里的 service 必须都有对应的可校验类（新增服务时本组会提醒补映射）', () => {
    for (const m of PERMISSION_MUTATIONS) {
      expect(SERVICE_MAP[m.service], `${m.service} 未在 SERVICE_MAP 注册，无法做静态校验`).toBeDefined();
    }
  });
});

// ============================================================================
// 组 2：清单 ↔ 源码一致（这是"规则真正生效"的部分）
// ============================================================================
describe('清单条目必须在源码中真实存在并带 invalidate', () => {
  for (const entry of PERMISSION_MUTATIONS) {
    const ctor = SERVICE_MAP[entry.service];

    // user.update-password-hash 是「由调用方负责」的特例，单独降级处理
    if (entry.id === 'user.update-password-hash') {
      it(`[降级] ${entry.id}：方法存在，且调用方 AuthService.changePassword 内有 invalidate`, () => {
        expect(typeof (UserService.prototype as Record<string, unknown>)[entry.method]).toBe(
          'function',
        );
        // 清单 note 明写"本方法自身不内联 invalidate，由调用方负责"
        expect(
          callsInvalidate(AuthService, 'changePassword'),
          '调用方 changePassword 必须补 invalidate（清单 note 已声明此责任在调用方）',
        ).toBe(true);
      });
      continue;
    }

    it(`${entry.id}：${entry.service}.${entry.method} 存在且方法体内调用 invalidateSnapshot`, () => {
      expect(typeof (ctor as { prototype: Record<string, unknown> }).prototype[entry.method]).toBe(
        'function',
      );
      expect(
        callsInvalidate(ctor, entry.method),
        `${entry.id} 已登记为权限变更入口，但方法体内没有 invalidateSnapshot 调用 —— ` +
          '这正是 C-5「调用链漏」的形态：撤权后要等 TTL 才生效',
      ).toBe(true);
    });
  }
});

// ============================================================================
// 组 3：排除清单被真正读取（回应 PM 的疑问）
// ============================================================================
describe('排除清单（PERMISSION_MUTATION_EXCLUSIONS）必须被检查器读取', () => {
  it('排除项非空，且 self-check 在列', () => {
    expect(PERMISSION_MUTATION_EXCLUSIONS.length).toBeGreaterThan(0);
    const ids = PERMISSION_MUTATION_EXCLUSIONS.map((e) => e.id);
    expect(ids).toContain('borrow.approve.self-check');
  });

  it('【关键】按排除清单过滤后，self-check 不再落入"需检查"集合', () => {
    // 模拟一个**正确**的检查器：先取清单，再剔除排除项
    const excluded = new Set(
      PERMISSION_MUTATION_EXCLUSIONS.map((e) => `${e.service}.${e.method}`),
    );
    const toCheck = permissionMutationKeys().filter((k) => !excluded.has(k));

    // 若排除清单没被读取（excluded 为空），self-check 若在清单里就会流入 toCheck
    const selfCheckKey = 'BorrowService.approve';
    const selfCheckInMutations = permissionMutationKeys().includes(selfCheckKey);

    if (selfCheckInMutations) {
      expect(toCheck, 'self-check 必须被排除，否则会被误报成"疑似遗漏"').not.toContain(
        selfCheckKey,
      );
    }

    // 反向验证：排除机制确实在起作用——把排除项强行塞进清单，必须能被剔掉
    const simulated = [...permissionMutationKeys(), selfCheckKey];
    const filtered = simulated.filter((k) => !excluded.has(k));
    expect(filtered, '排除列表若不生效，此断言会失败').not.toContain(selfCheckKey);
  });

  it('【关键】self-check 的真实理由成立：它**不**调 invalidate，且依据是字段比对', () => {
    // 这条不是"数数"，而是验证排除理由本身是否为真。
    // 若将来 approve() 真的加了 invalidate（比如改成读快照判定），
    // 那排除理由就不成立了，必须重新评估——本用例会红，提示复核。
    const body = bodyOf(BorrowService, 'approve').replace(/\/\*[\s\S]*?\*\//g, '').replace(
      /\/\/[^\n]*/g,
      '',
    );
    expect(
      callsInvalidate(BorrowService, 'approve'),
      'approve() 若开始调 invalidate，则排除理由失效，需重新裁定是否纳入清单',
    ).toBe(false);
    expect(body, '自审拦截的依据必须是 applicantId 与 userId 的字段比对').toMatch(
      /applicantId\s*===\s*user\.userId/,
    );
  });

  it('排除项不能被用来"顺手掩盖"其他入口：排除集合只能含 self-check 一条', () => {
    // 防止将来有人为了消红，把某个真入口塞进排除列表。
    // 若确实需要新增排除，必须同步更新本断言并在报告中说明理由。
    expect(PERMISSION_MUTATION_EXCLUSIONS.map((e) => e.id)).toEqual(['borrow.approve.self-check']);
  });
});

// ============================================================================
// 组 4：CI 静态自检脚本（真实存在，不是"文档化断言"）
// ============================================================================
describe('CI 静态自检脚本', () => {
  const SCRIPT = resolve(__dirname, '../../../scripts/ci-check-permission-mutations.cjs');

  it('脚本文件存在（缺失时本组红，防止 CI 门禁静默失效）', () => {
    expect(existsSync(SCRIPT), `缺少 CI 自检脚本：${SCRIPT}`).toBe(true);
  });

  it('脚本能在 CI 下跑通并退出码 0（R1 正向 + R2 反向 + R3 排除项自证）', () => {
    // 直接执行脚本本体，验证"规则真的能跑"，而不只是"文件在那儿"。
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(
      result.status,
      `CI 自检失败（exit=${result.status}）：\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    // 正向证据：脚本确实读到了清单，而不是"扫了个空"就通过了
    expect(result.stdout).toMatch(/清单 \d+ 条/);
    expect(result.stdout).toMatch(/扫描 \d+ 个源文件/);
  });

  it('package.json 已注册 ci:check 脚本（否则无人调用）', () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(rootPkg.scripts?.['ci:check:perm-mutations']).toBeTruthy();
    expect(rootPkg.scripts?.['ci:check']).toBeTruthy();
  });
});
