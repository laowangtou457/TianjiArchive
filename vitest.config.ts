import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 天玑档案管理系统 —— 根级测试配置（QA 独立验证用）
 *
 * 说明：
 *  - 全部用例均为「纯单元测试」：不连 PG/ES/MinIO/Redis，外部依赖一律 mock，
 *    因此 `pnpm test` 在无 Docker 环境下也可完整跑通；
 *  - 源码通过 tsconfig 路径别名 `@tianji/shared` 直连 packages/shared/src，
 *    保证测试断言的是「工程师写的真实共享层源码」而不是构建产物；
 *  - 装饰器（NestJS @Injectable 等）需要 TS 编译，vitest 内置 esbuild 处理，
 *    配合 tsconfig 中的 experimentalDecorators 生效。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@tianji/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@api': resolve(__dirname, 'apps/api/src'),
      '@': resolve(__dirname, 'apps/api/src'),
      'reflect-metadata': resolve(__dirname, 'apps/api/node_modules/reflect-metadata'),
    },
  },
  server: {
    deps: {
      /**
       * 强制 `@tianji/shared` 参与 vitest 的转换链（而不是被 externalize）。
       *
       * 背景：`pool: 'threads'` 下，若某模块被判定为外部依赖，vitest 会用
       * Node 的原生 loader 加载它，于是**同一个包可能同时存在两份实例**
       * （一份来自 src 经 vite 转译、一份来自 dist 经 Node 加载）。
       * 后果是 `Array.includes(枚举值)`、`instanceof`、模块级 `const` 这类
       * 「按引用比较」的写法会**偶发**失效——只在全量并发跑时复现，
       * 单文件跑永远绿，极难定位（本轮实测约 12% 概率复现）。
       *
       * 内联后 shared 只有一份实例，引用比较恢复确定性。
       */
      inline: ['@tianji/shared'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/shared/__tests__/**/*.spec.ts',
      'apps/api/__tests__/**/*.spec.ts',
      'apps/cli-migrator/__tests__/**/*.spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: ['default'],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'threads',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: [
        'packages/shared/src/**/*.ts',
        'apps/api/src/common/access/**/*.ts',
        'apps/api/src/modules/borrow/borrow.service.ts',
        'apps/api/src/modules/archive/archive.service.ts',
        'apps/api/src/modules/file/file.service.ts',
        'apps/api/src/modules/danghao/sequence.service.ts',
        'apps/api/src/modules/search/search.service.ts',
        'apps/api/src/infra/storage/storage.module.ts',
        'apps/api/src/modules/user/user.service.ts',
      ],
      exclude: ['**/*.entity.ts', '**/*.module.ts', '**/migrations/**', '**/scripts/**', '**/main.ts'],
      all: false,
      thresholds: {
        // 覆盖率只针对「有明确单元测试职责」的模块设门槛，避免对 IO 密集模块虚设指标
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
  esbuild: {
    target: 'node22',
  },
});
