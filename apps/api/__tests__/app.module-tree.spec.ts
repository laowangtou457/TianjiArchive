import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import {
  GLOBAL_MODULE_METADATA,
  MODULE_METADATA,
} from '@nestjs/common/constants';
import type { DynamicModule, ForwardReference, Type } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AccessModule } from '../src/common/access/access.module';
import { AccessFilterBuilder } from '../src/common/access/access-filter.builder';

/**
 * 应用模块树守卫（防回归，源自 2026-11-07 联调现场缺陷家族）。
 *
 * 事故家族：「模块缺 import」——
 *   形态① AccessModule 标了 @Global() 却未被 AppModule import 进模块树，
 *        全局 DI 失效，容器启动即崩（4118d48 修复）；
 *   形态② BackupModule 未 import ParamModule，BackupService 注入
 *        ParamService 失败（联调 restart 循环暴露，已修）。
 *   单测手工构造 service、从不 boot 应用，装配层零覆盖，两种形态都漏检。
 *
 * 守卫分工（为什么拆三处）：
 *   守卫 1、2（本文件）—— 只依赖 @Module/@Global 装饰器的显式元数据，
 *        esbuild 链可发射，vitest 内直接跑；
 *   形态②全量审计 —— 依赖 design:paramtypes（构造器类型注入元数据），
 *        仅 tsc 发射、esbuild 不发射（已探针证伪：同逻辑在 vitest 下
 *        扫到 0 个注入点、假性全绿），故独立为 ts-node 脚本
 *        `src/scripts/check-module-wiring.ts`（CI 挂 `ci:check:module-wiring`），
 *        守卫 3 验证「脚本真跑、退出码 0、且正向证据非零」。
 *
 * 变异验证：守卫 1 在 4118d48 之前精确红（missing=['AccessModule']）；
 * 审计脚本在 BackupModule 修复前报「BackupModule 未 import ParamModule」。
 */

type ModuleEntry = Type<unknown> | DynamicModule | ForwardReference;

/** 取模块条目的真实模块类（兼容 class / DynamicModule / forwardRef 三种形态） */
function resolveModuleClass(entry: ModuleEntry): Type<unknown> | null {
  if (typeof entry === 'function') return entry as Type<unknown>;
  const dynamic = entry as DynamicModule;
  if (dynamic?.module) return dynamic.module;
  const forwarded = entry as ForwardReference;
  if (typeof forwarded?.forwardRef === 'function') {
    return forwarded.forwardRef() as Type<unknown>;
  }
  return null;
}

/** 收集根模块的 transitive imports 闭包 */
function collectImportGraph(root: Type<unknown>): Set<Type<unknown>> {
  const seen = new Set<Type<unknown>>();
  const walk = (mod: Type<unknown>): void => {
    if (seen.has(mod)) return;
    seen.add(mod);
    const entries: ModuleEntry[] =
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ?? [];
    for (const entry of entries) {
      const cls = resolveModuleClass(entry);
      if (cls) walk(cls);
    }
  };
  walk(root);
  return seen;
}

/** 扫描 src 下全部 *.module.ts，返回模块类清单 */
function discoverModules(): Type<unknown>[] {
  const files = import.meta.glob('../src/**/*.module.ts', { eager: true });
  const modules: Type<unknown>[] = [];
  for (const mod of Object.values(files)) {
    for (const exported of Object.values(mod as Record<string, unknown>)) {
      if (typeof exported !== 'function') continue;
      const isModule =
        Reflect.getMetadata(MODULE_METADATA.IMPORTS, exported) !==
          undefined ||
        Reflect.getMetadata(MODULE_METADATA.PROVIDERS, exported) !==
          undefined ||
        Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, exported) !==
          undefined ||
        Reflect.getMetadata(MODULE_METADATA.EXPORTS, exported) !== undefined;
      if (isModule) modules.push(exported as Type<unknown>);
    }
  }
  return modules;
}

describe('应用模块树守卫', () => {
  it('源码中每个 @Global() 模块都在 AppModule 的 imports 闭包内', () => {
    const graph = collectImportGraph(AppModule);
    const globals = discoverModules().filter(
      (m) => Reflect.getMetadata(GLOBAL_MODULE_METADATA, m) === true,
    );

    expect(globals.length).toBeGreaterThan(0);
    const missing = globals.filter((g) => !graph.has(g));
    expect(missing.map((m) => m.name)).toEqual([]);
  });

  it('AccessModule 可装配，AccessFilterBuilder 可从 DI 容器解析', async () => {
    const testingModule = await Test.createTestingModule({
      imports: [AccessModule],
    }).compile();
    const builder = testingModule.get(AccessFilterBuilder);
    expect(builder).toBeInstanceOf(AccessFilterBuilder);
    await testingModule.close();
  });

  it('模块间装配审计脚本通过（含正向证据，非空转）', () => {
    const API_DIR = resolve(__dirname, '..');
    const TS_NODE_BIN = resolve(
      API_DIR,
      'node_modules/ts-node/dist/bin.js',
    );
    // 与 permission-mutations 的 runner 用例同法：直接 spawn node 执行脚本，
    // 不经 npx/shell（Windows 下 spawn .cmd 无 shell 会 ENOENT，status=null）
    const result = spawnSync(
      process.execPath,
      [
        TS_NODE_BIN,
        '--transpile-only',
        'src/scripts/check-module-wiring.ts',
      ],
      { encoding: 'utf8', cwd: API_DIR, timeout: 240_000 },
    );
    expect(
      result.status,
      `装配审计失败（exit=${result.status}，error=${result.error}）：\n` +
        `${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    // 正向证据：确实扫到了模块与注入点，而不是"扫了个空"就通过
    expect(result.stdout).toMatch(/扫描 \d+ 个模块，校验 \d+ 个构造器注入点/);
    expect(result.stdout).toContain('模块间装配审计通过');
  });
});
