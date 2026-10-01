import { defineConfig } from 'tsdown';

// 构建插件只在 Node 里、由 vite.config 加载，Vite 的配置文件是 ES 模块，所以只发布 ESM。
// vite 是 peer 依赖、@trace-pilot/shared 是普通依赖，都保持 external。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  outExtensions: () => ({ js: '.js' }),
});
