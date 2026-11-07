import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vite 配置
 * - 开发期 /api 代理到本地 API（3000）
 * - pdfjs worker 与 echarts 走 manualChunks 拆包，保障首屏 <2s（NFR-4）
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          mui: ['@mui/material', '@mui/icons-material'],
          charts: ['echarts', 'echarts-for-react'],
          pdf: ['react-pdf', 'pdfjs-dist'],
          query: ['@tanstack/react-query', 'axios', 'zustand'],
        },
      },
    },
  },
  optimizeDeps: {
    // @tianji/shared 是 workspace 内源码包，已提供 ESM 产物（dist/esm）。
    // 交给 Vite 直接按 exports.import 条件解析，不做预构建，避免开发/生产两套解析路径不一致。
    exclude: ['@tianji/shared'],
  },
});
