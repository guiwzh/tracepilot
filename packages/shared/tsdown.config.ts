import { defineConfig } from 'tsdown';

// 同时发布 ESM 与 CJS。扩展名写死，与 package.json 的 exports（index.js / index.cjs）对应。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  outExtensions: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
