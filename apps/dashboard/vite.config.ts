import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 负责开发服务器和生产打包；React 插件提供 JSX 转换与 Fast Refresh。
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // 把体积较大的稳定依赖拆成长期缓存 chunk，业务页面更新时无需重复下载。
        manualChunks: {
          charts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
        },
      },
    },
  },
});
