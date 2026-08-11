# 阶段 07 — 生产产物加固

## 阶段目标

修复“构建命令成功，但 Node.js 无法运行构建产物”的发布阻断问题，并让 CI 直接验证生产入口，
而不再只验证 TypeScript 源码和打包过程。

## 实现步骤

1. 将 `@trace-pilot/shared` 的运行时入口从 `src/index.ts` 改为 `dist`，同时输出 ESM 与 CJS，
   并分别声明 `import`、`require` 和类型入口。
2. 将 `@trace-pilot/monitor-sdk` 的 ESM、CJS 和类型入口统一指向实际构建产物。
3. 为开发服务器保留 `development` 源码条件，并通过 TypeScript 路径映射让全新检出的仓库可以在
   尚未构建 `dist` 时执行类型检查。
4. 新增 `smoke:production`：分别以 ESM 和 CJS 加载 SDK、加载共享包，再用临时 SQLite 数据库
   启动 `apps/server/dist/index.js` 并请求 `/health`。
5. 将生产烟雾测试加入根目录 `verify`，使 GitHub Actions 在生产入口损坏时直接失败。

## 验证方式

```bash
pnpm build
pnpm smoke:production
pnpm verify
```

烟雾测试使用随机空闲端口和操作系统临时目录，结束后会关闭进程并删除临时数据，不会改动演示
数据库。
