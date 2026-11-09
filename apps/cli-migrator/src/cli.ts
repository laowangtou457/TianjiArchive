#!/usr/bin/env node
import { Command } from 'commander';
import { Pool as PgPool } from 'pg';
import { Client as MinioClient } from 'minio';
import * as path from 'node:path';
import { ExcelReader } from './excel.reader';
import { FileMatcher } from './file.matcher';
import { Checkpoint } from './checkpoint';
import { Migrator, type MigratorOptions } from './migrator';
import { ReportWriter, type MigrationResultItem, type ReportInput } from './report';

/** CLI 版本 */
const VERSION = '1.0.0';

/**
 * 存量数据迁移 CLI（PRD F-12）。
 *
 * 用法示例：
 *   tianji-migrate template -o ./catalog-template.xlsx
 *   tianji-migrate run --excel ./catalog.xlsx --dir ./files --checkpoint ./migrate.db --dry-run
 *   tianji-migrate run --excel ./catalog.xlsx --dir ./files --report ./report.xlsx
 *   tianji-migrate status --checkpoint ./migrate.db
 *   tianji-migrate reset --checkpoint ./migrate.db
 */
const program = new Command();

program
  .name('tianji-migrate')
  .description('天玑档案管理系统 —— 存量数据迁移工具（Excel 目录 + 文件目录树挂接，支持断点续传）')
  .version(VERSION);

/** 生成导入模板 */
program
  .command('template')
  .description('生成标准 Excel 导入模板')
  .option('-o, --out <path>', '输出文件路径', './catalog-template.xlsx')
  .action(async (opts: { out: string }) => {
    const reader = new ExcelReader();
    const abs = path.resolve(opts.out);
    await reader.writeTemplate(abs);
    console.log(`模板已生成：${abs}`);
    console.log('请按模板填写「档号」「题名」等列，保管期限（永久/30/10）、密级（公开/内部/秘密）');
  });

/** 执行迁移 */
program
  .command('run')
  .description('执行迁移（先解析校验 → 扫描匹配 → 逐档号入库挂接，支持断点续传）')
  .requiredOption('-e, --excel <path>', 'Excel 目录文件路径')
  .requiredOption('-d, --dir <path>', '电子文件根目录')
  .option('-c, --checkpoint <path>', '断点状态库（SQLite）', './.tianji-migrate.db')
  .option('-r, --report <path>', '比对报告输出路径', './migration-report.xlsx')
  .option('-s, --sheet <name>', '指定工作表名（默认第一个）')
  .option('--dry-run', '试运行：只校验与匹配，不写库', false)
  .option('--max-files <n>', '单档号文件数上限', '50')
  .option('--concurrency <n>', '上传并发数', '4')
  .option(
    '--batch-max-rows <n>',
    '单批导入行数上限（对应系统参数 import.batch_max_rows，缺省 100000）',
    '100000',
  )
  .option('--operator <name>', '迁移操作人（用于创建人字段）', 'migration-bot')
  .option('--reset', '清空断点后重新执行', false)
  .action(
    async (opts: {
      excel: string;
      dir: string;
      checkpoint: string;
      report: string;
      sheet?: string;
      dryRun: boolean;
      maxFiles: string;
      concurrency: string;
      operator: string;
      reset: boolean;
      batchMaxRows: string;
    }) => {
      const startedAt = new Date().toISOString();
      console.log('▶ 步骤 1/4：解析 Excel 目录…');
      const reader = new ExcelReader();
      const parsed = await reader.read(path.resolve(opts.excel), opts.sheet);
      console.log(`  解析到 ${parsed.rows.length} 行，校验问题 ${parsed.issues.length} 个`);

      const errorCount = parsed.issues.filter((i) => i.level === 'ERROR').length;
      if (errorCount > 0) {
        console.warn(`  ⚠ 存在 ${errorCount} 个致命校验问题（相关行将跳过，详见报告）`);
      }

      console.log('▶ 步骤 2/4：扫描文件目录并匹配档号…');
      const matcher = new FileMatcher();
      const match = await matcher.scan(
        path.resolve(opts.dir),
        parsed.rows.map((r) => r.danghao),
      );
      console.log(
        `  扫描 ${match.total} 个文件，匹配到 ${match.byDanghao.size} 个档号，未挂接 ${match.unmatched.length} 个`,
      );

      console.log('▶ 步骤 3/4：初始化断点状态库…');
      const cp = new Checkpoint(path.resolve(opts.checkpoint));
      if (opts.reset) {
        cp.reset();
        console.log('  已清空断点（全量重跑）');
      }
      cp.setMeta('sourceExcel', path.resolve(opts.excel));
      cp.setMeta('sourceDir', path.resolve(opts.dir));
      cp.setMeta('startedAt', startedAt);
      cp.seed(
        parsed.rows.map((r) => ({
          danghao: r.danghao,
          files: (match.byDanghao.get(r.danghao) ?? []).map((f) => ({
            relPath: f.relPath,
            absPath: f.absPath,
            size: f.size,
          })),
        })),
      );

      console.log('▶ 步骤 4/4：执行迁移…');
      // pg.Pool 的配置类型（PoolConfig）包含 max，此处用 Pool 而非 Client 以便并发写入
      const pg = new PgPool({
        host: process.env.POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        user: process.env.POSTGRES_USER ?? 'tianji',
        password: process.env.POSTGRES_PASSWORD ?? '',
        database: process.env.POSTGRES_DB ?? 'tianji_archive',
        max: Math.max(2, Number(opts.concurrency) || 4),
      });
      // MINIO_* 为 S3 兼容配置名，后端实现为 SeaweedFS S3 Gateway（方案 A）
      const minio = new MinioClient({
        endPoint: process.env.MINIO_ENDPOINT ?? 'seaweedfs',
        port: Number(process.env.MINIO_PORT ?? 8333),
        useSSL: (process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY ?? 'tianji_minio',
        secretKey: process.env.MINIO_SECRET_KEY ?? 'tianji_minio_change_me',
      });

      if (!opts.dryRun) {
        // Pool 惰性建连，这里主动取一条连接验证可达性（失败会抛出，便于提前中止）
        const probe = await pg.connect();
        probe.release();
      }

      const migratorOpts: MigratorOptions = {
        dryRun: opts.dryRun,
        maxFilesPerItem: Math.max(1, Number(opts.maxFiles) || 50),
        concurrency: Math.max(1, Number(opts.concurrency) || 4),
        operator: opts.operator,
        enqueueExtract: false,
      };
      const migrator = new Migrator(pg, minio, migratorOpts);

      const rowMap = new Map(parsed.rows.map((r) => [r.danghao, r]));
      const issueByDanghao = new Map<string, string>();
      for (const issue of parsed.issues.filter((i) => i.level === 'ERROR')) {
        // 行号 → 档号（可能为空，此时用行号占位）
        const row = parsed.rows.find((r) => r.rowNo === issue.rowNo);
        if (row) issueByDanghao.set(row.danghao, issue.message);
      }

      const results: MigrationResultItem[] = [];
      // 单批导入行数上限：由 `--batch-max-rows` 承接系统参数 import.batch_max_rows。
      // 本进程是独立 CLI，不持有 ParamService（无 Nest 容器、无 DB 连接参数表），
      // 因此该参数在此处「由运维显式传入」而非「运行时读取」——这是有意的边界，
      // 见 PARAM_DEFS 中 import.batch_max_rows 的 consumer 说明。
      const batchMaxRows = Math.max(1, Number(opts.batchMaxRows) || 100000);
      if (Number(opts.batchMaxRows) !== batchMaxRows) {
        console.warn(`  ⚠ --batch-max-rows 取值非法，已回落到 ${batchMaxRows}`);
      }
      const pending = cp.pending(batchMaxRows);
      let index = 0;

      for (const danghao of pending) {
        index += 1;
        const row = rowMap.get(danghao);
        if (!row) {
          cp.markSkipped(danghao, 'Excel 中找不到该档号（断点残留）');
          results.push({ danghao, status: 'SKIPPED', itemId: null, fileCount: 0, error: 'Excel 缺失' });
          continue;
        }
        const blocking = issueByDanghao.get(danghao);
        if (blocking) {
          cp.markSkipped(danghao, blocking);
          results.push({ danghao, status: 'SKIPPED', itemId: null, fileCount: 0, error: blocking });
          continue;
        }

        const files = match.byDanghao.get(danghao) ?? [];
        const r = await migrator.migrateOne(row, files);
        results.push(r);
        if (r.status === 'DONE') cp.markDone(danghao, r.itemId ?? '', r.fileCount);
        else if (r.status === 'FAILED') cp.markFailed(danghao, r.error ?? '未知错误');
        else cp.markSkipped(danghao, r.error ?? '');

        if (index % 50 === 0) {
          console.log(`  进度 ${index}/${pending.length}（成功 ${cp.summary().done}）`);
        }
      }

      const finishedAt = new Date().toISOString();
      const summary = cp.summary();

      const reportInput: ReportInput = {
        sourceExcel: path.resolve(opts.excel),
        sourceDir: path.resolve(opts.dir),
        dryRun: opts.dryRun,
        startedAt,
        finishedAt,
        totalRows: parsed.rows.length,
        results,
        issues: parsed.issues,
        match,
        summary,
      };

      const writer = new ReportWriter();
      writer.printConsole(reportInput);
      await writer.write(reportInput, path.resolve(opts.report));

      cp.close();
      if (!opts.dryRun) await pg.end();

      if (summary.failed > 0) {
        console.warn('存在失败记录，可修复后重跑同一命令（已成功部分会自动跳过）');
        process.exitCode = 2;
      }
    },
  );

/** 查看进度 */
program
  .command('status')
  .description('查看迁移进度（断点状态库统计与失败明细）')
  .option('-c, --checkpoint <path>', '断点状态库路径', './.tianji-migrate.db')
  .action((opts: { checkpoint: string }) => {
    const cp = new Checkpoint(path.resolve(opts.checkpoint));
    const s = cp.summary();
    console.log('迁移进度：');
    console.log(`  总档号 ${s.total}｜成功 ${s.done}｜失败 ${s.failed}｜跳过 ${s.skipped}｜待处理 ${s.pending}`);
    console.log(`  文件  成功 ${s.filesDone}｜失败 ${s.filesFailed}`);
    const failures = cp.failures(20);
    if (failures.length > 0) {
      console.log('失败/跳过明细（前 20 条）：');
      for (const f of failures) {
        console.log(`  - ${f.danghao}（尝试 ${f.attempts} 次）：${f.error}`);
      }
    }
    cp.close();
  });

/** 重置进度 */
program
  .command('reset')
  .description('清空断点状态（下次执行将全量重跑）')
  .option('-c, --checkpoint <path>', '断点状态库路径', './.tianji-migrate.db')
  .action((opts: { checkpoint: string }) => {
    const cp = new Checkpoint(path.resolve(opts.checkpoint));
    cp.reset();
    console.log('断点已清空');
    cp.close();
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`执行失败：${err.message}`);
  process.exitCode = 1;
});
