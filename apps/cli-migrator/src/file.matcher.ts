import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 文件条目 */
export interface FileEntry {
  /** 绝对路径 */
  absPath: string;
  /** 文件名 */
  filename: string;
  /** 相对根目录的路径（用于按档号匹配时展示） */
  relPath: string;
  /** 字节数 */
  size: number;
  /** 扩展名（小写，含点） */
  ext: string;
  /** 从路径提取的档号候选（最长匹配优先） */
  danghaoCandidates: string[];
}

/** 匹配结果 */
export interface MatchResult {
  /** 档号 → 文件列表 */
  byDanghao: Map<string, FileEntry[]>;
  /** 未匹配到任何档号的文件 */
  unmatched: FileEntry[];
  /** 一个档号匹配到多个文件的（需人工确认） */
  ambiguous: Array<{ danghao: string; files: FileEntry[] }>;
  /** 扫描到的文件总数 */
  total: number;
}

/**
 * 文件目录树扫描与档号挂接（PRD F-12）。
 *
 * 匹配策略（按优先级）：
 *   1) 文件名（去扩展名）完全等于档号；
 *   2) 文件名以「档号」开头，后接分隔符（-、_、空格、#、( )）或中文说明；
 *   3) 文件名包含档号（最长档号优先，避免 `...-0001` 误匹配 `...-00010`）；
 *   4) 父目录名等于档号（一个目录放多页扫描件时常见）。
 *
 * 命中多个文件视为「多页」，按文件名自然序排序后全部挂接（多件同名场景由人工在报告中确认）。
 */
export class FileMatcher {
  /** 扫描目录并匹配档号 */
  public async scan(rootDir: string, danghaos: string[]): Promise<MatchResult> {
    // 档号按长度降序，保证最长优先匹配
    const sorted = [...new Set(danghaos.filter(Boolean))].sort((a, b) => b.length - a.length);
    const files: FileEntry[] = [];
    await this.walk(rootDir, rootDir, files);

    const byDanghao = new Map<string, FileEntry[]>();
    const unmatched: FileEntry[] = [];

    for (const file of files) {
      const stem = file.filename.replace(/\.[^.]+$/, '');
      const parentName = path.basename(path.dirname(file.absPath));
      const candidate =
        sorted.find((d) => stem === d) ??
        sorted.find((d) => new RegExp(`^${this.escape(d)}[\\s_\\-#(（]`).test(stem)) ??
        sorted.find((d) => stem.includes(d)) ??
        sorted.find((d) => parentName === d) ??
        sorted.find((d) => parentName.includes(d));

      if (!candidate) {
        unmatched.push(file);
        continue;
      }
      const list = byDanghao.get(candidate) ?? [];
      list.push(file);
      byDanghao.set(candidate, list);
    }

    const ambiguous: MatchResult['ambiguous'] = [];
    for (const [danghao, list] of byDanghao) {
      if (list.length > 1) {
        // 多文件同名视为多页（合法），但若扩展名各异且文件名主干不同，则提示人工确认
        const stems = new Set(list.map((f) => f.filename.replace(/\.[^.]+$/, '')));
        if (stems.size > 1) ambiguous.push({ danghao, files: list });
      }
    }

    // 组内自然序排序（第2页在第10页前）
    for (const list of byDanghao.values()) {
      list.sort((a, b) => a.filename.localeCompare(b.filename, 'zh-CN', { numeric: true }));
    }

    return { byDanghao, unmatched, ambiguous, total: files.length };
  }

  /** 递归遍历目录 */
  private async walk(rootDir: string, curDir: string, out: FileEntry[]): Promise<void> {
    const entries = await fs.readdir(curDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(curDir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(rootDir, abs, out);
        continue;
      }
      if (!entry.isFile()) continue;
      // 跳过临时/隐藏文件
      if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue;

      const stat = await fs.stat(abs);
      out.push({
        absPath: abs,
        filename: entry.name,
        relPath: path.relative(rootDir, abs),
        size: stat.size,
        ext: path.extname(entry.name).toLowerCase(),
        danghaoCandidates: [],
      });
    }
  }

  /** 正则转义 */
  private escape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
