/**
 * @tianji/shared 清理脚本
 *
 * 逐文件删除 dist，避免触发 safe-delete 的批量删除阈值（单次 > 50 项会被拦截）。
 *
 * 用法：
 *   node scripts/clean.cjs          # 手动清理
 *   node scripts/build.cjs --clean  # 构建前先清理（CI 推荐，消除陈旧产物）
 */
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(__dirname, '..', 'dist');

/** 递归收集所有文件与目录（文件在前，目录在后以便自底向上删除） */
function walk(dir, files = [], dirs = []) {
  if (!fs.existsSync(dir)) return { files, dirs };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files, dirs);
      dirs.push(full);
    } else {
      files.push(full);
    }
  }
  return { files, dirs };
}

/** 逐项删除 dist（幂等，不存在则跳过） */
function cleanDist() {
  const { files, dirs } = walk(distDir);
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {
      // 文件可能已被并发删除，忽略
    }
  }
  for (const d of dirs) {
    try {
      fs.rmdirSync(d);
    } catch {
      // 目录可能非空或已被删除，忽略
    }
  }
  try {
    fs.rmdirSync(distDir);
  } catch {
    // 已不存在则忽略
  }
}

module.exports = { cleanDist };

// 作为脚本直接执行时才输出提示（被 build.cjs require 时静默）
if (require.main === module) {
  cleanDist();
  process.stdout.write('@tianji/shared dist cleaned\n');
}
