import ExcelJS from 'exceljs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RowIssue } from './excel.reader';
import type { MatchResult } from './file.matcher';

/** 迁移结果项 */
export interface MigrationResultItem {
  danghao: string;
  status: 'DONE' | 'FAILED' | 'SKIPPED';
  itemId: string | null;
  fileCount: number;
  error: string | null;
}

/** 报告输入 */
export interface ReportInput {
  sourceExcel: string;
  sourceDir: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  totalRows: number;
  results: MigrationResultItem[];
  issues: RowIssue[];
  match: MatchResult;
  summary: {
    total: number;
    done: number;
    failed: number;
    skipped: number;
    pending: number;
    filesDone: number;
    filesFailed: number;
  };
}

/**
 * 迁移比对报告生成器。
 *
 * 产出：
 *   - 控制台摘要（中文，一眼看清成败）；
 *   - xlsx 报告（4 个 Sheet：总览 / 失败明细 / 校验问题 / 未挂接文件），供档案馆复核归档。
 */
export class ReportWriter {
  /** 控制台摘要 */
  public printConsole(input: ReportInput): void {
    const ok = input.summary.done;
    const fail = input.summary.failed;
    const skip = input.summary.skipped;
    const lines = [
      '',
      '════════════════════ 迁移比对报告 ════════════════════',
      `源 Excel     ︰ ${input.sourceExcel}`,
      `源文件目录   ︰ ${input.sourceDir}`,
      `模式         ︰ ${input.dryRun ? '试运行（不写库）' : '正式执行'}`,
      `起止时间     ︰ ${input.startedAt} → ${input.finishedAt}`,
      '------------------------------------------------------',
      `Excel 行数   ︰ ${input.totalRows}`,
      `扫描文件数   ︰ ${input.match.total}`,
      `成功         ︰ ${ok}`,
      `失败         ︰ ${fail}`,
      `跳过         ︰ ${skip}`,
      `待处理       ︰ ${input.summary.pending}`,
      `文件成功/失败︰ ${input.summary.filesDone} / ${input.summary.filesFailed}`,
      `校验问题     ︰ ${input.issues.length}（ERROR ${input.issues.filter((i) => i.level === 'ERROR').length}）`,
      `未挂接文件   ︰ ${input.match.unmatched.length}`,
      `疑似多件同名 ︰ ${input.match.ambiguous.length}`,
      '══════════════════════════════════════════════════════',
      '',
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }

  /** 写 xlsx 报告 */
  public async write(input: ReportInput, outPath: string): Promise<string> {
    const wb = new ExcelJS.Workbook();
    wb.creator = '天玑档案管理系统 · 迁移工具';
    wb.created = new Date();

    // 1) 总览
    const overview = wb.addWorksheet('总览');
    overview.columns = [
      { header: '项目', key: 'k', width: 24 },
      { header: '内容', key: 'v', width: 60 },
    ];
    const passRate =
      input.summary.total === 0 ? '0%' : `${((input.summary.done / input.summary.total) * 100).toFixed(2)}%`;
    overview.addRows([
      { k: '源 Excel', v: input.sourceExcel },
      { k: '源文件目录', v: input.sourceDir },
      { k: '执行模式', v: input.dryRun ? '试运行（不写库）' : '正式执行' },
      { k: '开始时间', v: input.startedAt },
      { k: '结束时间', v: input.finishedAt },
      { k: 'Excel 行数', v: input.totalRows },
      { k: '扫描文件数', v: input.match.total },
      { k: '成功档号数', v: input.summary.done },
      { k: '失败档号数', v: input.summary.failed },
      { k: '跳过档号数', v: input.summary.skipped },
      { k: '待处理档号数', v: input.summary.pending },
      { k: '成功率', v: passRate },
      { k: '文件成功数', v: input.summary.filesDone },
      { k: '文件失败数', v: input.summary.filesFailed },
      { k: '未挂接文件数', v: input.match.unmatched.length },
    ]);

    // 2) 失败明细
    const failed = wb.addWorksheet('失败明细');
    failed.columns = [
      { header: '档号', key: 'danghao', width: 28 },
      { header: '状态', key: 'status', width: 10 },
      { header: '文件数', key: 'fileCount', width: 10 },
      { header: '失败原因', key: 'error', width: 70 },
    ];
    for (const r of input.results.filter((x) => x.status !== 'DONE')) {
      failed.addRow({ ...r, error: r.error ?? '' });
    }

    // 3) 校验问题
    const issues = wb.addWorksheet('校验问题');
    issues.columns = [
      { header: '行号', key: 'rowNo', width: 8 },
      { header: '级别', key: 'level', width: 8 },
      { header: '字段', key: 'field', width: 16 },
      { header: '原始值', key: 'value', width: 30 },
      { header: '说明', key: 'message', width: 60 },
    ];
    for (const i of input.issues) issues.addRow(i);

    // 4) 未挂接文件
    const unmatched = wb.addWorksheet('未挂接文件');
    unmatched.columns = [
      { header: '相对路径', key: 'relPath', width: 60 },
      { header: '文件名', key: 'filename', width: 40 },
      { header: '大小（字节）', key: 'size', width: 14 },
    ];
    for (const f of input.match.unmatched) unmatched.addRow(f);

    // 5) 疑似多件同名
    if (input.match.ambiguous.length > 0) {
      const amb = wb.addWorksheet('疑似冲突');
      amb.columns = [
        { header: '档号', key: 'danghao', width: 28 },
        { header: '文件', key: 'files', width: 80 },
      ];
      for (const a of input.match.ambiguous) {
        amb.addRow({ danghao: a.danghao, files: a.files.map((f) => f.filename).join(' | ') });
      }
    }

    for (const ws of wb.worksheets) {
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }

    const abs = path.resolve(outPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await wb.xlsx.writeFile(abs);
    // eslint-disable-next-line no-console
    console.log(`比对报告已生成：${abs}`);
    return abs;
  }
}
