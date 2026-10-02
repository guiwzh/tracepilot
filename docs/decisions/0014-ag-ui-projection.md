# ADR 0014：调查事件流在出口上投影成 AG-UI

- 状态：已采纳
- 日期：2026-10-02

## 背景

排障 Agent 的进度通过 SSE 推给工作台，事件是 TracePilot 自己定义的（`run.started`、`tool.called`、`report.rejected`……）。
工作台读得懂，别的前端读不懂：想把调查嵌进 CopilotKit 这类 Agent 前端，得为它再写一套解析。

AG-UI（Agent–User Interaction Protocol）是 Agent 与前端之间的事件协议，1.0 定义了运行的开始与结束、
流式的文字消息、工具调用与结果、共享状态（快照 + JSON Patch），并有官方 SDK（`@ag-ui/core` 1.0.0 于 2026-09-17 发布）。它和 MCP 分工互补：
MCP 管 Agent 怎么调工具（TracePilot 已经用它把工具开放给编码 Agent），AG-UI 管 Agent 怎么把过程交给界面。

## 决策

1. **事件日志仍是唯一的事实来源**：落库、可回放、工作台照旧读它。AG-UI 是出口上的一层投影（`investigation/agui.ts`），
   不改动存储，也不改动工作台。
2. **映射**：旁白 → `TEXT_MESSAGE_START / CONTENT / END`；工具调用 → `TOOL_CALL_START / ARGS / END`，结果 →
   `TOOL_CALL_RESULT`（短编号、耗时等放在 `metadata.tracepilot`）；循环的一轮 → `STEP_STARTED / FINISHED`；
   完成 → `RUN_FINISHED`（outcome `success`，`result` 是报告）；取消 → `RUN_FINISHED`（outcome `cancelled`）；
   失败 → `RUN_ERROR`；用量按协议的 `TokenUsage`。协议没有「证据核验」这样的概念，报告、被驳回的引用和用量放进
   **共享状态**：开头一个 `STATE_SNAPSHOT`，之后用 `STATE_DELTA` 更新。
3. **两个出口**：`GET /api/v1/investigations/:runId/ag-ui` 回放并续传一次调查（事件 id 为「seq.序号」）；
   `POST /api/v1/ag-ui` 是标准的 Agent 端点，收 `RunAgentInput`（`threadId` 是 Issue id），发起或接上调查并推送事件，
   官方 `HttpAgent` 指向它就能用。
4. **用官方实现验收**：测试里每个事件都过 `@ag-ui/core` 的 Schema，并由 `@ag-ui/client` 的 `HttpAgent` 消费——
   它校验事件顺序（结束前消息、工具调用、轮次都要收尾），再把事件应用成消息和状态。

## 替代方案

- **把内部事件直接换成 AG-UI**：日志里有协议不关心的信息（结果的短编号、被驳回的具体原因），落库格式也要迁移；
  而且协议升级时，存储要跟着变。投影把协议的变化挡在出口上。
- **工作台也改成读 AG-UI**：工作台要按证据跳回对应的工具结果、显示核验失败的原因，这些在 AG-UI 里只能塞进 metadata
  再解出来，等于绕一圈读回自己的事件。工作台是领域界面，AG-UI 面向通用的 Agent 前端。
- **只把内部事件包进 `CUSTOM` 事件**：形式上合规，通用前端仍然什么也显示不了。

## 影响

- 新增运行时依赖 `@ag-ui/core`（只用它的事件类型常量和 `RunAgentInput` 的 Schema，没有传递依赖）；
  `@ag-ui/client` 只用于测试。
- `POST /api/v1/ag-ui` 生成自己的 runId：同一个 Issue 只跑一个调查，接上别人发起的那次时没法用请求里的 runId。
  断开连接不取消调查（与工作台一致），取消走 `/cancel`。
- 抽出共用的 SSE 推送函数时发现：请求对象的 `close` 在请求体读完时就会触发，带请求体的 POST 会在第一批事件后被当成断开。
  改为监听响应的 `close`。
