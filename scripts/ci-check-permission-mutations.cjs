#!/usr/bin/env node
/**
 * CI 静态自检：`PERMISSION_MUTATIONS` 清单 ↔ 源码调用点一致性。
 *
 * ## 为什么是独立脚本，而不只是 vitest 用例
 *
 * `apps/api/__tests__/permission-mutations.consistency.spec.ts` 依赖 Nest 容器与
 * class 原型（`fn.toString()`），它跑在 vitest 里，需要 ts 转译链；
 * 本脚本是**纯文本扫描**：不加载任何业务代码、不需要 DB/Redis/Node 运行时特性，
 * 因此可以放进 pre-commit / PR gate，秒级出结果，且不会被"测试没跑到"绕过。
 *
 * 两者是互补关系，不是替代：
 *   - 本脚本：覆盖「新增了第 11 处入口，清单没登记」这一最常见漏法（反向扫描）；
 *   - vitest 用例：覆盖「清单登记了但方法体没 invalidate」+ 排除理由是否仍成立。
 *
 * ## 检查规则（三条）
 *
 * R1 **正向**：清单里每个 `Service.method`，在其源文件中该方法体内必须存在
 *     `invalidateSnapshot(` 调用（剥掉注释后判定）。排除项 `PERMISSION_MUTATION_EXCLUSIONS`
 *     不参与（它们本就依赖字段比对，不读权限快照）。
 *
 * R2 **反向**：服务源码里，凡是「写权限/角色/数据范围/用户状态」的方法，
 *     必须已在清单中登记或已在排除清单中显式声明。
 *     判定依据是一组**意图明确的代码特征**（见 WRITE_SIGNALS），
 *     而不是靠人肉维护白名单——否则第 11 处新增时清单不会红。
 *
 * R3 **排除项自证**：排除项的源文件里不能出现 `invalidateSnapshot(`，
 *     否则说明排除理由（"不读快照"）已失效，必须重新裁定。
 *
 * ## 退出码
 *   0 = 全部通过
 *   1 = 发现问题（打印明细）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API_SRC = path.join(ROOT, 'apps', 'api', 'src');

/**
 * 清单是 TypeScript 源（packages/shared/src/permission-mutations.ts）。
 * 本脚本用正则抽取，避免引入 ts 运行时依赖。
 */
const MUTATIONS_FILE = path.join(ROOT, 'packages', 'shared', 'src', 'permission-mutations.ts');

/**
 * 「写权限」的代码特征。任一条命中即视为**权限变更入口候选**，必须登记。
 *
 * 设计原则：只收**结构性且指向明确**的信号，宁可窄不可宽。
 * 每条都必须能指向"这行代码改变了某个用户的权限判定结果"。
 *
 * ⚠️ 刻意**不**收 `xxxRepo.update(...)` 这种泛写：全仓每个 service 都在 update，
 * 会把归档著录、借阅流转、备份记录全扫成"可疑"，规则立刻变成噪音源后被关掉。
 * 真正的权限写入一定落在**下面这些具名仓储/具名字段**上。
 */
const WRITE_SIGNALS = [
  // 用户-角色关联（roles 表）增删
  { re: /userRoleRepo\.(save|insert|delete|remove|softDelete)/, desc: '用户-角色关联写入' },
  { re: /roleRepo\.(save|insert|delete|remove|softDelete)/, desc: '角色表写入' },
  // 数据范围（user_data_scope 表）写入
  { re: /dataScopeRepo\.(save|insert|delete|remove)/, desc: '数据范围写入' },
  { re: /userDataScopeRepo\.(save|insert|delete|remove)/, desc: '数据范围写入' },
  // 角色权限矩阵（role_permission）写入
  { re: /rolePerm(ission)?Repo\.(save|insert|delete|remove)/, desc: '角色权限矩阵写入' },
  // 用户状态字段被直接更新（停用/锁定 → 快照必须失效）
  { re: /\bstatus\s*:\s*UserStatus\.(DISABLED|LOCKED|ACTIVE)/, desc: '用户状态变更' },
  // 密码哈希落库
  { re: /\bpasswordHash\s*[:=]/, desc: '密码哈希写入' },
];

// ------------------------------------------------------------------ 工具

/** 递归收集 .ts 源文件（跳过 __tests__ 与 dist） */
function collectSources(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') {
        continue;
      }
      collectSources(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** 剥掉块注释与行注释（保留字符串内容原样，够用即可） */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * 从 permission-mutations.ts 里抽取清单条目。
 *
 * 期望形态（源码结构稳定，已由 shared 的测试保证）：
 *   { id: 'xxx', service: 'UserAdminService', method: 'assignRoles', ... }
 *   { id: 'yyy', service: '...', method: '...', ... }  // 排除清单同理
 */
function parseEntries(source, collectionName) {
  // 匹配 `export const NAME ... = [`，跳过中间的 `readonly Foo[]` 类型注解
  const declRe = new RegExp(String.raw`export const ${collectionName}\b[^=]*=\s*\[`);
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(`在 ${MUTATIONS_FILE} 中找不到 export const ${collectionName} 的数组字面量`);
  }
  const openIdx = declMatch.index + declMatch[0].length - 1; // 指向 '['
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) throw new Error(`${collectionName} 数组括号不配平`);

  const block = source.slice(openIdx, endIdx + 1);
  const entries = [];
  const re = /id:\s*'([^']+)'[\s\S]*?service:\s*'([^']+)'[\s\S]*?method:\s*'([^']+)'/g;
  let m = re.exec(block);
  while (m !== null) {
    entries.push({ id: m[1], service: m[2], method: m[3] });
    m = re.exec(block);
  }
  return entries;
}

/** 把 'UserAdminService' 映射到源文件路径（apps/api/src 下按类名搜） */
function buildServiceFileIndex(files) {
  const index = new Map();
  for (const file of files) {
    const base = path.basename(file, '.ts');
    // user-admin.service.ts → UserAdminService
    const guessed = base
      .split(/[.-]/)
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join('');
    index.set(guessed, file);
  }
  return index;
}

/**
 * 遍历一个 TS 源文件中的所有「类方法」，产出 { methodName, body }。
 *
 * 不用「按方法名重搜」的写法（那会撞到同名方法与调用点），
 * 而是**从左到右单遍扫描**：找到一个像方法声明的位置后，
 * 就地配平参数列表与花括号，取到方法体，然后从方法体末尾继续扫。
 *
 * 刻意排除的形态（否则会被当成方法）：
 *   - 装饰器 `@Injectable()`：前面带 `@`；
 *   - 接口 / 类型别名里的方法签名：后面跟 `;` 而非 `{`；
 *   - 关键词 `if/for/while/switch/catch/function`；
 *   - 对象字面量的键（前面是 `{` 或 `,` 且后面紧跟 `:`）。
 */
const NON_METHOD_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'constructor_never', 'return', 'typeof',
]);

function iterateMethods(code) {
  const out = [];
  const declRe =
    /(?:^|\n)([ \t]*)(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;

  let m = declRe.exec(code);
  while (m !== null) {
    const methodName = m[2];
    const matchStart = m.index + m[0].indexOf(m[1]) + m[1].length;

    // 前面紧挨 `@` 的是装饰器，跳过
    const prevChar = code.slice(Math.max(0, matchStart - 1), matchStart);
    if (prevChar === '@' || NON_METHOD_WORDS.has(methodName)) {
      m = declRe.exec(code);
      continue;
    }

    // 配平参数列表
    let i = m.index + m[0].length;
    let paren = 1;
    while (i < code.length && paren > 0) {
      if (code[i] === '(') paren += 1;
      else if (code[i] === ')') paren -= 1;
      i += 1;
    }
    if (paren !== 0) break;

    // 跳过返回类型注解，找到方法体起始 `{`。
    //
    // 坑：返回类型里**可能含 `{`**，例如 `Promise<{ disabled: boolean }>`。
    // 因此不能"找第一个 `{`"，必须先跳过泛型参数 `<...>`（跟踪尖括号深度），
    // 只有在尖括号外遇到的 `{` 才是方法体。
    let angle = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '<') angle += 1;
      else if (ch === '>') angle = Math.max(0, angle - 1);
      else if (angle === 0 && (ch === '{' || ch === ';' || ch === '=')) break;
      i += 1;
    }
    if (i >= code.length || code[i] !== '{') {
      // 抽象方法 / 接口签名：没有方法体，跳过
      declRe.lastIndex = i;
      m = declRe.exec(code);
      continue;
    }

    // 配平方法体
    const bodyStart = i;
    let depth = 0;
    let j = i;
    for (; j < code.length; j += 1) {
      if (code[j] === '{') depth += 1;
      else if (code[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    out.push({ methodName, body: code.slice(bodyStart, j) });

    declRe.lastIndex = j;
    m = declRe.exec(code);
  }
  return out;
}

/**
 * 按**精确方法名**取方法体（R1 / R3 用：清单里给定了 service + method）。
 *
 * 复用 {@link iterateMethods} 的单遍扫描结果，避免"按名字重搜"撞到同名调用点。
 * 找不到返回 null，由调用方报错——绝不静默跳过。
 */
function extractMethodBody(code, method) {
  const found = iterateMethods(code).filter((x) => x.methodName === method);
  if (found.length === 0) return null;
  if (found.length > 1) {
    // 同一文件内同名方法（如 getter/setter 或重载实现）取最长的那段——
    // 最短的通常是重载签名（无方法体），已在上游被过滤掉。
    return found.reduce((a, b) => (a.body.length >= b.body.length ? a : b)).body;
  }
  return found[0].body;
}

// ------------------------------------------------------------------ 主流程

function main() {
  const problems = [];
  const info = [];

  if (!fs.existsSync(MUTATIONS_FILE)) {
    console.error(`✗ 找不到清单文件：${MUTATIONS_FILE}`);
    process.exit(1);
  }
  const mutationSource = fs.readFileSync(MUTATIONS_FILE, 'utf8');
  const mutations = parseEntries(mutationSource, 'PERMISSION_MUTATIONS');
  const exclusions = parseEntries(mutationSource, 'PERMISSION_MUTATION_EXCLUSIONS');

  if (mutations.length === 0) {
    problems.push('PERMISSION_MUTATIONS 为空数组——规则会静默失效，拒绝通过');
  }

  const sources = collectSources(API_SRC);
  const fileIndexOf = buildServiceFileIndex(sources);

  const excludedKeys = new Set(exclusions.map((e) => `${e.service}.${e.method}`));

  // ---------------- R1 正向：清单条目方法体内必须有 invalidateSnapshot
  for (const entry of mutations) {
    const key = `${entry.service}.${entry.method}`;
    if (excludedKeys.has(key)) {
      info.push(`R1 跳过（已排除）：${key}`);
      continue;
    }
    const file = fileIndexOf.get(entry.service);
    if (!file) {
      problems.push(`R1 [${entry.id}] 找不到服务 ${entry.service} 的源文件`);
      continue;
    }
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const body = extractMethodBody(code, entry.method);
    if (body === null) {
      problems.push(`R1 [${entry.id}] 在 ${path.relative(ROOT, file)} 中找不到方法 ${entry.method}`);
      continue;
    }

    // 跨方法特例（清单 note 显式声明"本方法不内联 invalidate，责任在调用方"）：
    // 只校验方法存在 + 调用方有 invalidate，不在本方法体内要求。
    if (entry.id === 'user.update-password-hash') {
      info.push(`R1 降级（责任在调用方）：${key}`);
      const authFile = fileIndexOf.get('AuthService');
      if (!authFile) {
        problems.push('R1 [user.update-password-hash] 找不到 AuthService 源文件，无法校验调用方');
      } else {
        const authCode = stripComments(fs.readFileSync(authFile, 'utf8'));
        const authBody = extractMethodBody(authCode, 'changePassword');
        if (authBody === null || !/invalidateSnapshot\s*\(/.test(authBody)) {
          problems.push(
            'R1 [user.update-password-hash] 该方法自身不内联 invalidate，' +
              '清单声明责任在调用方 AuthService.changePassword，但调用方也没有',
          );
        }
      }
      continue;
    }

    if (!/invalidateSnapshot\s*\(/.test(body)) {
      problems.push(
        `R1 [${entry.id}] ${key} 已登记为权限变更入口，但方法体内无 invalidateSnapshot 调用 —— ` +
          '撤权将延迟到 TTL 才生效',
      );
    }
  }

  // ---------------- R2 反向：源码里的写权限动作必须已登记
  const registeredKeys = new Set(mutations.map((m) => `${m.service}.${m.method}`));
  for (const file of sources) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = stripComments(raw);
    const base = path.basename(file, '.ts');
    const className =
      base
        .split(/[.-]/)
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
        .join('') || base;

    for (const { methodName, body } of iterateMethods(code)) {
      for (const signal of WRITE_SIGNALS) {
        if (!signal.re.test(body)) continue;
        const key = `${className}.${methodName}`;
        if (registeredKeys.has(key) || excludedKeys.has(key)) break;
        problems.push(
          `R2 [未登记] ${path.relative(ROOT, file)} 的 ${key} 含有「${signal.desc}」动作，` +
            '但不在 PERMISSION_MUTATIONS 也不在排除清单中 —— 这是"第 11 处遗漏"的典型形态',
        );
        break;
      }
    }
  }

  // ---------------- R3 排除项自证：断言其"不读快照"的理由仍成立
  // 排除项依据是字段比对（applicantId === user.userId），不读权限快照。
  // 若其方法体里出现 invalidateSnapshot，说明实现改成读快照了，排除理由失效。
  for (const ex of exclusions) {
    const file = fileIndexOf.get(ex.service);
    if (!file) {
      problems.push(`R3 [${ex.id}] 找不到服务 ${ex.service} 的源文件`);
      continue;
    }
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const body = extractMethodBody(code, ex.method);
    if (body === null) {
      problems.push(`R3 [${ex.id}] 找不到方法 ${ex.service}.${ex.method}`);
      continue;
    }
    if (/invalidateSnapshot\s*\(/.test(body)) {
      problems.push(
        `R3 [${ex.id}] 该方法已开始调用 invalidateSnapshot，` +
          '「不读权限快照」的排除理由失效，必须重新裁定是否纳入清单',
      );
    }
  }

  // ---------------- 输出
  for (const line of info) console.log(`  · ${line}`);

  if (problems.length > 0) {
    console.error(`\n✗ 权限变更入口静态自检失败，共 ${problems.length} 项：\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `\n✓ 权限变更入口静态自检通过` +
      `（清单 ${mutations.length} 条 / 排除 ${exclusions.length} 条 / 扫描 ${sources.length} 个源文件）\n`,
  );
}

main();
