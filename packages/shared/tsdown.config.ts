import { defineConfig } from 'tsdown';

// 同时发布 ESM 与 CJS。扩展名写死，与 package.json 的 exports（index.js / index.cjs）对应。
// 按源码模块分文件输出（unbundle）：schemas.ts、investigation.ts 顶层的 z.object(...) 摇不掉，打成一个文件时，
// 接入方引入任何运行时值（例如 SDK 用的脱敏函数）都会连带整个 zod，SDK 的接入成本从约 16 KB 变成约 110 KB gzip。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  unbundle: true,
  outExtensions: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
