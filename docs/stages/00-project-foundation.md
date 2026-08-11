# 阶段 00 — 项目基础

## 阶段成果

建立 TracePilot pnpm 工作区、统一的 TypeScript/lint/格式化规则、共享运行时 Schema、隐私工具、
环境变量模板和架构决策记录。

## 实现步骤

1. 创建支持并行开发和仓库级验证的工作区脚本。
2. 添加由所有包共享的严格 TypeScript 配置和 ESLint 扁平配置。
3. 使用 Zod 定义监控事件信封、Issue 状态和证据诊断 Schema。
4. 添加通用 API/领域类型，避免客户端重复定义服务端响应契约。
5. 实现递归敏感字段脱敏和 URL 查询参数移除，并添加单元测试覆盖。
6. 记录本地优先架构与事件传输契约。

## 验证方式

```bash
pnpm --filter @trace-pilot/shared typecheck
pnpm --filter @trace-pilot/shared test
pnpm --filter @trace-pilot/shared build
```

## 明确的权衡

- 直接导出包源码可加快本地开发；生产打包仍通过 tsup 验证。
- 可运行的 MVP 选择 SQLite，同时将存储细节限制在服务端应用内部。
- 共享事件载荷允许扩展，但外围信封保持严格约束。
