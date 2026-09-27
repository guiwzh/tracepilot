import { defineConfig } from 'tsdown';

// 服务端只需要一个 Node ESM 入口；依赖（含原生模块 better-sqlite3）保持 external，运行时从 node_modules 加载。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  outExtensions: () => ({ js: '.js' }),
});
