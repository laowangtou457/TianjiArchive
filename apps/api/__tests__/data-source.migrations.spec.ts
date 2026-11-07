import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDataSourceOptions,
  migrationGlobFor,
} from '../src/infra/database/data-source';

/**
 * 迁移发现防回归（缺陷 #10「CLI 静默空跑」家族的静态侧守卫）。
 *
 * 事故（2026-11-07 联调现场）：迁移通配按「目录是否存在」取 *.js，
 *   ts-node 下匹配 0 个文件，CLI 报「No migrations are pending」——
 *   数据库除 typeorm_migrations 外零表却显示无待执行迁移。
 *   修复（4d44a20）按 __dirname 是否处于 dist 判定扩展名；
 *   次生缺陷（1f7b5be）：宽泛 *.ts 又误纳 seed-data.ts（共享种子构建
 *   函数，非迁移）致「migration name is wrong」，通配收窄为 [0-9]* 前缀。
 *
 * 为什么不做运行时「executedMigrations.length > 0」断言：
 *   运行路径含 migrationsRun（每次启动都跑），已迁移库上合法地执行 0 条，
 *   恒 >0 断言会误报；「 fresh 库才要求 >0」又需要前置表存在性检查，
 *   复杂度不值。静态守卫（本文件）直接钉死「双模式下发现集非空且
 *   不含非迁移文件」，把静默空跑掐在 CI 阶段。
 */

const MIGRATIONS_DIR = join(__dirname, '../src/infra/database/migrations');

/** 与迁移通配 [0-9]*.{ext} 同语义的本匹配 */
function matchesMigrationPattern(name: string, ext: string): boolean {
  return /^[0-9]/.test(name) && name.endsWith(`.${ext}`);
}

describe('迁移发现守卫', () => {
  it('selector 双分支：dist 目录取 .js，源码树取 .ts', () => {
    expect(migrationGlobFor('/app/dist/infra/database')).toBe(
      join('/app/dist/infra/database', 'migrations/[0-9]*.js'),
    );
    expect(migrationGlobFor('/repo/apps/api/src/infra/database')).toBe(
      join('/repo/apps/api/src/infra/database', 'migrations/[0-9]*.ts'),
    );
  });

  it('源码树迁移发现集非空，且不含 seed-data.ts 等非迁移文件', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    const discovered = files.filter((f) => matchesMigrationPattern(f, 'ts'));

    // 正向证据（§6.1 第六条：发现数必须 > 0，防空转）
    expect(discovered.length).toBeGreaterThan(0);
    // seed-data.ts 不得进入发现集（1f7b5be 次生缺陷形态）
    expect(discovered.some((f) => f === 'seed-data.ts')).toBe(false);
    // 目录里确实存在 seed-data.ts（若将来被删，本断言提醒同步删除此守卫说明）
    expect(files).toContain('seed-data.ts');
  });

  it('buildDataSourceOptions 的 migrations 配置非空', () => {
    const opts = buildDataSourceOptions();
    expect(Array.isArray(opts.migrations)).toBe(true);
    expect(opts.migrations?.length).toBeGreaterThan(0);
  });
});
