# 阶段 11：平台使用手册

## 目标

把分散在 README、演示脚本和源码中的使用信息整理为一份面向平台使用者的中文操作手册，并让
README 提供明确入口。

## 实现步骤

1. 启动并访问 Dashboard 和 Playground，核对实际页面、导航、控件和英文标签。
2. 检查项目创建、Issue 筛选、详情证据、性能指标、Release、Source Map 和诊断实现。
3. 新增 docs/user-guide.md，覆盖启动、快速体验、业务接入、日常排障、隐私边界和常见问题。
4. 明确 pnpm seed 会重建演示数据，以及本地 MVP 的鉴权、删除、部署和扩展性限制。
5. 在 README 的快速开始和详细文档入口中链接使用手册。

## 关键取舍

- 手册使用中文说明，但保留界面中的英文按钮和栏目名称，避免操作时无法对应。
- 不把尚未实现的生产部署、用户认证或公共 SDK 发布写成可用能力。
- Source Map、诊断缓存、DSN 配对和 SDK 默认值均以当前代码行为为准。
- 将人工证据核验放在 AI 诊断之前，延续平台的 evidence-first 原则。

## 验证

- 实际访问项目首页、Issues、Issue 详情、Performance、Releases 和 Playground。
- 对照 Dashboard 路由、SDK 类型、服务端配置、Source Map 服务和诊断实现复核文档。
- 使用 Prettier 检查新增和修改的 Markdown。
- 检查 README 中的相对链接可解析到目标文件。

## 产出

- docs/user-guide.md
- docs/stages/11-platform-user-guide.md
- README.md 中的平台使用手册入口
