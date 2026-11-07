/* eslint-env node */
/**
 * 全局 ESLint 配置 —— 覆盖 apps/api、apps/extractor、apps/cli-migrator、packages/shared、apps/web。
 * 说明：使用 ESLint 8 的 .eslintrc 经典配置，避免 v9 flat config 对 NestJS 生态的兼容问题。
 */
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-empty-function': ['warn', { allow: ['constructors'] }],
    '@typescript-eslint/no-empty-interface': 'off',
    'no-console': 'off',
    eqeqeq: ['error', 'smart'],
    'prefer-const': 'error',
  },
  overrides: [
    {
      files: ['apps/web/**/*.{ts,tsx}'],
      env: { browser: true, node: true },
      settings: { react: { version: 'detect' } },
      rules: {
        'react/jsx-uses-react': 'off',
        'react/react-in-jsx-scope': 'off',
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
    {
      files: ['**/*.spec.ts', '**/*.test.ts', 'scripts/**/*.ts'],
      env: { node: true, jest: true },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '*.js',
    '*.cjs',
    '*.mjs',
    'vite.config.ts.bak',
  ],
};
