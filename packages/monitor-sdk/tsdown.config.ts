import { defineConfig } from 'tsdown';

/**
 * 浏览器 SDK 的发布构建：压缩并附带 Source Map。
 * 运行时依赖（@trace-pilot/shared、web-vitals）保持 external，由接入方的打包器决定是否摇树——
 * 这也是 measure-sdk 需要额外测「真实接入成本」的原因。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'browser',
  dts: true,
  minify: true,
  sourcemap: true,
  outExtensions: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
