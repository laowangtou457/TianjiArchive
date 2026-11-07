import { describe, expect, it } from 'vitest';
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
 * 应用模块树冒烟守卫（防回归，源自 2026-11-07 联调现场缺陷）。
 *
 * 事故：AccessModule 标了 @Global() 却未被 AppModule import 进模块树，
 *   Nest 的 @Global 只在模块属于模块树时才生效 → SearchService 等
 *   注入 AccessFilterBuilder 全部 DI 失败，api 容器启动即崩。
 *   418 条单测全绿但无一条 boot 整个应用，装配层零覆盖，故漏检。
 *
 * 为什么不做「全量 boot AppModule」：
 *   TypeORM/Redis/ES 在 onModuleInit 即连接外部服务，全量 compile 会
 *   破坏本仓「pnpm test 无 Docker 可跑」的设计约束（vitest.config.ts
 *   头注）。故拆为两层守卫，均不触外部依赖：
 *     1) 模块树图守卫——transitive imports 闭包必须包含源码中
 *        每一个 @Global() 模块（本缺陷的精确形态）；
 *     2) 装配冒烟——AccessModule 可 compile 且 AccessFilterBuilder
 *        可解析（providers 声明与 DI 容器行为的真实校验）。
 *
 * 变异验证：修复前本文件第 1 组用例必红（AccessModule 不在闭包内）。
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

/** 扫描 src 下全部 *.module.ts，返回其中标了 @Global() 的模块类 */
function discoverGlobalModules(): Type<unknown>[] {
  const files = import.meta.glob('../src/**/*.module.ts', { eager: true });
  const globals: Type<unknown>[] = [];
  for (const mod of Object.values(files)) {
    for (const exported of Object.values(
      mod as Record<string, unknown>,
    )) {
      if (typeof exported !== 'function') continue;
      if (Reflect.getMetadata(GLOBAL_MODULE_METADATA, exported) === true) {
        globals.push(exported as Type<unknown>);
      }
    }
  }
  return globals;
}

describe('应用模块树守卫', () => {
  it('源码中每个 @Global() 模块都在 AppModule 的 imports 闭包内', () => {
    const graph = collectImportGraph(AppModule);
    const globals = discoverGlobalModules();

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
});
