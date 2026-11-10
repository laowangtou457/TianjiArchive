/**
 * 片段索引重建脚本（存量迁移 / 手工修复 / 上线首跑）。
 *
 * 用法：
 *   pnpm --filter @tianji/api kb:reindex            # 只处理陈旧或未索引的条目（推荐）
 *   pnpm --filter @tianji/api kb:reindex -- --all   # 全量重建（忽略陈旧判定）
 *   pnpm --filter @tianji/api kb:reindex -- --item <itemId>[,<itemId>...]
 *
 * 为什么走 Nest 应用上下文而不是裸 DataSource：
 *   索引器依赖 DataSource + KbEsService（→ EsService → ConfigService）。用应用上下文
 *   拿到的就是**生产同一条装配链**，脚本本身即是一次装配校验（模块漏 import 会当场炸）。
 *
 * 幂等：同一 item 重建 = 先删后插；ES 文档 `_id = itemId:chunkNo` 幂等 upsert。
 * 可反复执行，结果收敛。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { KbIndexer } from '../modules/kb/kb.indexer';
import { KbEsService } from '../modules/kb/kb.es';

/** 每批条目数（与 cron 自愈共用同一判定） */
const BATCH = 200;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const itemArg = argv[argv.indexOf('--item') + 1];
  const explicit = argv.includes('--item') && itemArg ? itemArg.split(',').map((s) => s.trim()) : [];

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const indexer = app.get(KbIndexer);
    const es = app.get(KbEsService);
    await es.ensureIndex();

    let targets: string[];
    if (explicit.length > 0) {
      targets = explicit;
    } else if (all) {
      // 全量：直接扫 archive_item（含已软删的也不要——它们不该进检索索引）
      targets = await indexer.listAllItemIdsWithText();
    } else {
      targets = await indexer.findStaleItemIds(BATCH);
    }

    if (targets.length === 0) {
      console.log('无待重建条目（索引已是最新）');
      return 0;
    }

    console.log(`待重建条目：${targets.length}${all ? '（全量）' : ''}`);

    // 分批处理，避免一次性占用过多连接
    let items = 0;
    let chunks = 0;
    let failed = 0;
    const touched: string[] = [];
    for (let i = 0; i < targets.length; i += BATCH) {
      const slice = targets.slice(i, i + BATCH);
      const r = await indexer.indexItems(slice);
      items += r.items;
      chunks += r.chunks;
      failed += r.failed;
      touched.push(...slice);
      console.log(`  进度 ${Math.min(i + BATCH, targets.length)}/${targets.length}：片段 ${chunks}`);
    }

    await es.refresh();

    // 回读校验：随机抽 3 个条目，确认片段数与 ES 命中一致（防止"写成功但没进索引"）
    const samples = touched.slice(0, 3);
    for (const id of samples) {
      const pgCount = await indexer.countChunksOfItem(id);
      const esCount = await es.countByItem(id);
      const ok = pgCount === esCount;
      console.log(`  校验 ${id}: PG 片段=${pgCount} ES 文档=${esCount}${ok ? ' ✓' : ' ✗ 不一致'}`);
      if (!ok) failed += 1;
    }

    console.log(`完成：条目 ${items}，片段 ${chunks}，失败 ${failed}`);
    return failed > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('片段重建失败:', err);
    process.exit(1);
  });
