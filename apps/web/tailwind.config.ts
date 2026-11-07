import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置：仅做布局/间距微调，组件样式统一由 MUI 主题（theme.ts）承载。
 * preflight 关闭，避免与 MUI 的 CSSBaseline 冲突。
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // 深靛蓝主色（政务沉稳），与 MUI 主题保持一致
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#4f6ef7',
          600: '#2a45c4',
          700: '#1f359b',
          800: '#1a2b7a',
          900: '#152260',
        },
      },
      spacing: {
        // 高密度业务界面基础间距
        'row': '2.25rem',
      },
      fontSize: {
        'dense': ['0.8125rem', { lineHeight: '1.35rem' }],
      },
      screens: {
        // 1366x768 起（PRD §7.4）
        xs: '480px',
      },
    },
  },
  plugins: [],
};

export default config;
