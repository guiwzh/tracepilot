import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // 把体积较大的稳定依赖拆成长期缓存 chunk，业务页面更新时无需重复下载。
        // Vite 8 起由 Rolldown 打包，按模块路径匹配分组，取代 Rollup 的 manualChunks。
        codeSplitting: {
          groups: [
            { name: 'charts', test: /[\\/]node_modules[\\/](echarts|zrender)[\\/]/ },
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@tanstack[\\/]react-query)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
