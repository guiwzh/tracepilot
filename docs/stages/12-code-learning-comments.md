# 阶段 12：中文代码注释与阅读路线

## 目标

为不熟悉当前技术栈的开发者补充可学习的中文注释，并提供从浏览器采集到 Dashboard 展示的代码
阅读路线，同时保持所有运行逻辑不变。

## 实现步骤

1. 盘点 75 个 TypeScript、TSX、MJS 与配置文件，按 Shared、SDK、Server、Dashboard、
   Playground、测试与脚本分组。
2. 在核心模块补充模块职责、生命周期、数据边界、缓存、事务、脱敏和降级策略注释。
3. 在测试与配置中解释 Vitest、happy-dom、Playwright、Vite、ESLint 和生产冒烟测试的作用。
4. 新增 docs/code-reading-guide.md，提供技术栈地图、数据流、推荐阅读顺序和调试入口。
5. 使用 Prettier 格式化，运行 git diff 检查确保只增加注释和文档。
6. 执行 pnpm verify 与 pnpm test:e2e，确认类型、测试、构建和真实浏览器闭环。

## 注释原则

- 解释为什么这样设计，而不是逐行翻译代码。
- 优先解释陌生框架机制、资源清理、安全边界和容易产生副作用的代码。
- 不给显而易见的 JSX 标签和简单赋值堆叠注释。
- 注释使用中文，代码标识和界面名称保持原文，便于搜索。
- 注释不能承诺当前 MVP 尚未实现的生产能力。

## 覆盖范围

- Zod 运行时契约、TypeScript 类型推导与共享 DTO。
- SDK 插件生命周期、浏览器全局 API 包装、Web Vitals 与可靠传输。
- Fastify 应用工厂、SQLite/Drizzle、事务接入、Issue 指纹和查询聚合。
- Source Map 私有还原与证据化 AI 诊断。
- React Router、React Query、Zustand、ECharts 和 Vite。
- Vitest、happy-dom、Playwright、基准、评测和生产冒烟脚本。

## 产出

- 核心代码与配置中的中文教学注释。
- docs/code-reading-guide.md。
- docs/stages/12-code-learning-comments.md。
- README 中的代码阅读指南入口。
