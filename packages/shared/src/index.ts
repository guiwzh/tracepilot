// 注意：这个 barrel 同时导出了依赖 zod 的模块（schemas、investigation）。
// 浏览器侧能把 zod 摇掉，靠两件事：package.json 里的 "sideEffects": false 让打包器可以整个跳过没被用到的模块；
// 构建产物按源码模块分文件输出（tsdown.config.ts 的 unbundle），模块的边界才留得下来。但只要从 schemas.ts 或
// investigation.ts 引入任何一个运行时值，该模块顶层的 z.object(...) 就会连同 zod 一起进包（2026-10-05 实测：
// Dashboard 的详情页 chunk 从约 33 kB 涨到约 117 kB）。所以 SDK 和 Dashboard 只从这两个模块引入类型（import type）。
export * from './constants';
export * from './investigation';
export * from './redaction';
export * from './requests';
export * from './schemas';
export * from './types';
