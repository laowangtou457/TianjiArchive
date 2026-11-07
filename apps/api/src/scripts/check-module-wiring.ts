import 'reflect-metadata';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  GLOBAL_MODULE_METADATA,
  MODULE_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import type { DynamicModule, ForwardReference, Type } from '@nestjs/common';
import { AppModule } from '../app.module';

/**
 * 模块间 DI 装配审计（CI 静态自检，形态②「模块缺 import」守卫）。
 *
 * 背景（2026-11-07 联调现场缺陷家族）：
 *   BackupModule 未 import ParamModule → BackupService 注入 ParamService
 *   失败，容器 restart 循环。单测手工构造 service，装配层零覆盖。
 *   本脚本对每个模块 providers/controllers 的构造器注入（含 @Inject
 *   显式声明）逐项核对其提供方模块是否在本模块 imports 闭包内
 *   （或提供方 @Global 且已入树、或经 re-export 链可达）。
 *
 * 为什么必须是独立脚本而非 vitest 用例：
 *   构造器类型注入依赖 design:paramtypes 元数据，仅 tsc 发射；
 *   vitest 的 esbuild 链不发射该元数据（已探针证伪——同样的审计逻辑
 *   在 vitest 下扫到 0 个注入点、假性全绿）。ts-node（transpile-only，
 *   继承 tsconfig 的 emitDecoratorMetadata）可发射，故走脚本形态，
 *   与 ci-check-permission-mutations.cjs 同族。
 *
 * 用法（在 apps/api 目录下）：
 *   npx ts-node --transpile-only src/scripts/check-module-wiring.ts
 * 退出码：0 = 全部接线正确；1 = 存在 finding（逐条打印到 stderr）。
 */

type ModuleEntry = Type<unknown> | DynamicModule | ForwardReference;
type ClassToken = Type<unknown>;

interface ModuleInfo {
  cls: ClassToken;
  imports: ModuleEntry[];
  providers: unknown[];
  controllers: unknown[];
  exports: unknown[];
  isGlobal: boolean;
}

interface SelfDeclaredDep {
  index: number;
  param?: unknown;
  property?: string;
}

/** 递归收集目录下全部 *.module.ts（相对本文件的 src 根） */
function collectModuleFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) collectModuleFiles(full, acc);
    else if (name.endsWith('.module.ts')) acc.push(full);
  }
  return acc;
}

function resolveModuleClass(entry: ModuleEntry): ClassToken | null {
  if (typeof entry === 'function') return entry as ClassToken;
  const dynamic = entry as DynamicModule;
  if (dynamic?.module) return dynamic.module;
  const forwarded = entry as ForwardReference;
  if (typeof forwarded?.forwardRef === 'function') {
    return forwarded.forwardRef() as ClassToken;
  }
  return null;
}

function collectImportGraph(root: ClassToken): Set<ClassToken> {
  const seen = new Set<ClassToken>();
  const walk = (mod: ClassToken): void => {
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

function discoverModules(srcRoot: string): ClassToken[] {
  const files = collectModuleFiles(srcRoot);
  const modules: ClassToken[] = [];
  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const isModule =
        Reflect.getMetadata(MODULE_METADATA.IMPORTS, exported) !==
          undefined ||
        Reflect.getMetadata(MODULE_METADATA.PROVIDERS, exported) !==
          undefined ||
        Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, exported) !==
          undefined ||
        Reflect.getMetadata(MODULE_METADATA.EXPORTS, exported) !== undefined;
      if (isModule) modules.push(exported as ClassToken);
    }
  }
  return modules;
}

function providerTokens(providers: unknown[]): ClassToken[] {
  const tokens: ClassToken[] = [];
  for (const p of providers) {
    if (typeof p === 'function') {
      tokens.push(p as ClassToken);
      continue;
    }
    if (p && typeof p === 'object') {
      const record = p as Record<string, unknown>;
      if (typeof record.provide === 'function') {
        tokens.push(record.provide as ClassToken);
      }
      if (typeof record.useClass === 'function') {
        tokens.push(record.useClass as ClassToken);
      }
    }
  }
  return tokens;
}

function constructorTokens(cls: ClassToken): ClassToken[] {
  const tokens = new Set<ClassToken>();
  const paramtypes: unknown[] =
    Reflect.getMetadata(PARAMTYPES_METADATA, cls) ?? [];
  for (const t of paramtypes) {
    if (typeof t === 'function') tokens.add(t as ClassToken);
  }
  const selfDeclared: SelfDeclaredDep[] =
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) ?? [];
  for (const dep of selfDeclared) {
    if (typeof dep?.param === 'function') tokens.add(dep.param as ClassToken);
  }
  return [...tokens];
}

function main(): number {
  const srcRoot = join(__dirname, '..');
  const appGraph = collectImportGraph(AppModule);
  const moduleClasses = discoverModules(srcRoot);

  if (moduleClasses.length === 0) {
    console.error('审计无效：未发现任何模块类（扫描路径异常，禁止假性通过）');
    return 1;
  }

  const infos = new Map<ClassToken, ModuleInfo>();
  for (const cls of moduleClasses) {
    infos.set(cls, {
      cls,
      imports: (Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) ??
        []) as ModuleEntry[],
      providers: (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, cls) ??
        []) as unknown[],
      controllers: (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls) ??
        []) as unknown[],
      exports: (Reflect.getMetadata(MODULE_METADATA.EXPORTS, cls) ??
        []) as unknown[],
      isGlobal: Reflect.getMetadata(GLOBAL_MODULE_METADATA, cls) === true,
    });
  }

  const providerIndex = new Map<ClassToken, ModuleInfo>();
  for (const info of infos.values()) {
    for (const token of providerTokens(info.providers)) {
      if (!providerIndex.has(token)) providerIndex.set(token, info);
    }
  }

  const exportClosureCache = new Map<ClassToken, Set<ClassToken>>();
  const exportClosure = (info: ModuleInfo): Set<ClassToken> => {
    const cached = exportClosureCache.get(info.cls);
    if (cached) return cached;
    const tokens = new Set<ClassToken>();
    for (const e of info.exports) {
      if (typeof e !== 'function') continue;
      const reExported = infos.get(e as ClassToken);
      if (reExported) {
        for (const t of exportClosure(reExported)) tokens.add(t);
      } else {
        tokens.add(e as ClassToken);
      }
    }
    exportClosureCache.set(info.cls, tokens);
    return tokens;
  };

  const findings: string[] = [];
  const externalTokens = new Set<string>();
  let checked = 0;

  for (const info of infos.values()) {
    const consumers: ClassToken[] = [
      ...providerTokens(info.providers).filter((c) => !infos.has(c)),
      ...info.controllers.filter(
        (c): c is ClassToken =>
          typeof c === 'function' && !infos.has(c as ClassToken),
      ),
    ];

    for (const consumer of consumers) {
      for (const token of constructorTokens(consumer)) {
        checked += 1;
        const sameModule = providerTokens(info.providers).includes(token);
        const provider = providerIndex.get(token);
        if (!provider) {
          externalTokens.add(token.name);
          continue;
        }
        if (sameModule) continue;
        if (provider.isGlobal && appGraph.has(provider.cls)) continue;
        const closure = collectImportGraph(info.cls);
        let reachable = false;
        for (const imported of closure) {
          const importedInfo = infos.get(imported);
          if (importedInfo && exportClosure(importedInfo).has(token)) {
            reachable = true;
            break;
          }
        }
        if (!reachable) {
          findings.push(
            `${info.cls.name} 未 import ${provider.cls.name}（` +
              `${consumer.name} 注入 ${token.name}）`,
          );
        }
      }
    }
  }

  console.log(
    `扫描 ${infos.size} 个模块，校验 ${checked} 个构造器注入点` +
      `（跳过 ${externalTokens.size} 个框架/外部 token）`,
  );
  if (findings.length > 0) {
    console.error(`发现 ${findings.length} 处模块接线缺失：`);
    for (const f of findings.sort()) console.error(`  ✖ ${f}`);
    return 1;
  }
  console.log('模块间装配审计通过：全部构造器注入可达');
  return 0;
}

process.exit(main());
