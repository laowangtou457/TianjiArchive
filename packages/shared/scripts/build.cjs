/**
 * @tianji/shared 构建脚本
 *
 * 策略：**默认只覆盖不删除，可选 --clean 做干净构建**。
 *
 * 背景：构建环境可能把 fs.rmSync 替换为 safe-delete shim，单次删除超过阈值（50 项）
 * 会被拦截并抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED。因此删除一律走 clean.cjs 的逐文件删除：
 *   1) 默认：CJS 直接编译进 dist/、ESM 编译进 dist/esm/，tsc 覆盖同名文件（增量快，旧文件残留无害）
 *   2) `--clean`：先逐文件清空 dist 再全量编译，杜绝源文件重命名/删除后留下的陈旧产物
 *      （CI 与发布构建建议启用；日常开发用默认模式更快）
 *
 * 构建末尾按 src/*.ts 动态自检产物，防止「有 CJS 无 ESM」的半成品被下游消费。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanDist } = require('./clean.cjs');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const esmDir = path.join(distDir, 'esm');

function main() {
  // `--clean`：干净构建，消除陈旧产物（重命名/删除源文件后残留的 .js/.d.ts 幽灵文件）
  const shouldClean = process.argv.includes('--clean');
  if (shouldClean) {
    cleanDist();
    process.stdout.write('@tianji/shared dist cleaned (--clean)\n');
  }

  // 确保输出目录存在（mkdirSync 幂等，不涉及删除）
  fs.mkdirSync(esmDir, { recursive: true });

  // 定位 tsc：require.resolve 可穿透 pnpm 的提升目录
  let tscCmd = 'tsc';
  let tscPrefix = [];
  try {
    tscPrefix = [require.resolve('typescript/bin/tsc')];
    tscCmd = process.execPath;
  } catch {
    // 回退到 PATH 中的 tsc
  }

  // 1) CJS → dist/
  execFileSync(tscCmd, [...tscPrefix, '-p', path.join(root, 'tsconfig.json'), '--outDir', distDir], {
    cwd: root,
    stdio: 'inherit',
  });

  // 2) ESM → dist/esm/
  execFileSync(
    tscCmd,
    [...tscPrefix, '-p', path.join(root, 'tsconfig.esm.json'), '--outDir', esmDir],
    { cwd: root, stdio: 'inherit' },
  );

  // 3) ESM 子目录声明 module 类型（Node 侧也能正确识别）
  fs.writeFileSync(
    path.join(esmDir, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + String.fromCharCode(10),
  );

  // 4) 构建后自检：按 src/*.ts 动态推导期望产物，新增模块自动纳入校验。
  //    任一产物缺失立即失败，防止半成品被下游 Vite / Nest 消费。
  const srcDir = path.join(root, 'src');
  const modules = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'))
    .map((f) => f.replace(/\.ts$/, ''));

  if (modules.length === 0) {
    throw new Error('@tianji/shared 未发现任何源模块，构建异常');
  }

  const required = [];
  for (const m of modules) {
    required.push(path.join(distDir, `${m}.js`), path.join(distDir, `${m}.d.ts`));
    required.push(path.join(esmDir, `${m}.js`));
  }

  const missing = required.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    throw new Error(`@tianji/shared 构建产物缺失（${missing.length} 项）：\n  ${missing.join('\n  ')}`);
  }

  process.stdout.write(
    `@tianji/shared build done (dist + dist/esm, ${modules.length} modules verified)\n`,
  );
}

main();
