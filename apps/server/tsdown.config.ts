import { defineConfig } from 'tsdown';

// 两个 Node ESM 入口：服务端（dist/index.js）和 MCP 的 stdio 进程（dist/mcp.js）。
// 依赖（含原生模块 better-sqlite3）保持 external，运行时从 node_modules 加载。
export default defineConfig({
  entry: { index: 'src/index.ts', mcp: 'src/mcp/stdio.ts' },
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  outExtensions: () => ({ js: '.js' }),
});
