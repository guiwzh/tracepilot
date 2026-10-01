# ADR 0007：用 MCP 把只读工具开放给编码 Agent，与排障 Agent 共用一套工具注册表

- 状态：已采纳
- 日期：2026-10-01

## 背景

排障 Agent（ADR 0003）在 TracePilot 里回答「这个报错是怎么回事」，但修代码发生在开发者的编辑器里，由 Claude Code、
Cursor 这类编码 Agent 完成。两者之间原来只能靠人复制粘贴：从工作台抄堆栈和结论，贴进编辑器。编码 Agent 拿不到面包屑、
还原后的源码位置、版本分布，也分不清哪些结论是核实过的。

MCP（Model Context Protocol）已经是编码 Agent 接外部上下文的通用方式：Claude Code、Cursor、VS Code 都支持，可观测领域的
Sentry、Datadog、Grafana 也都提供了 MCP 服务器。

## 决策

1. **一套工具，两种调用方**：MCP 的工具直接由 `investigation/tools.ts` 的注册表生成（`z.toJSONSchema`），执行走同一个
   `runToolArgs`：同样的参数校验、同样在结果离开服务端前再脱敏一次、同样的长度上限。Agent 的工具绑定在一次调查的
   Issue 上，MCP 版本多一个 `issueId` 参数；另加 `list_projects`、`list_issues` 和 `get_latest_investigation`（读已经核实
   过引用的调查报告）。
2. **只读**：所有工具都只读，并在工具注解里声明 `readOnlyHint`；stdio 进程的数据库连接设 `PRAGMA query_only`。
3. **两种传输**：Streamable HTTP（`POST /mcp`，无状态，每个请求一个服务器实例）给远程或团队使用；stdio（本机子进程，
   直接读 SQLite 文件）给单机使用。
4. **项目级静态令牌**：`Authorization: Bearer tp_…`，数据库只存 SHA-256，明文只在创建时显示一次；不可见的 Issue 与不存在的
   回答一样。工作台直接给出 Claude Code 命令和 Cursor 配置。
5. 用官方 TypeScript SDK 的底层 `Server`（自己处理 `tools/list`、`tools/call`），而不是高层的 `registerTool`：
   JSON Schema 由我们的 Zod 定义生成，不依赖 SDK 对 Zod 版本的适配。

## 替代方案

- **给 MCP 单独写一套工具**：两套实现迟早漂移——Agent 那边修了脱敏或截断，MCP 这边忘了。
- **让编码 Agent 直接调 REST API**：每个客户端都要自己写调用和说明，没有工具清单和参数 Schema，也没有只读语义的声明。
- **有状态的 Streamable HTTP（会话 + SSE）**：只有服务器主动推送（进度通知、资源变更订阅）时才需要；这里的工具都是一问
  一答，有状态只会带来会话存储和多实例的会话粘滞问题。
- **MCP 规范的 OAuth 2.1 授权**：需要授权服务器、受保护资源元数据和客户端注册，对本地单用户的项目太重；静态令牌是主流
  MCP 客户端都支持的方式。列为已知限制。
- **开放写操作（改 Issue 状态、发起调查）**：编码 Agent 手里已经有写文件、执行命令的能力，再给它改监控数据的能力，
  被遥测里的间接提示词注入利用的后果更大。只读是刻意的边界。

## 影响

- 编码 Agent 可以在编辑器里完成「找到 Issue → 看证据 → 读出错行源码 → 对照本地代码修复」，并读到 TracePilot 已经核实
  过引用的调查报告。
- 工具结果里的文字来自终端用户的浏览器；`instructions` 和提示词模板都提醒客户端只把它当数据。
- 源码片段会经编码 Agent 发给它的模型服务商，受 `AGENT_SOURCE_CONTEXT` 同一个开关控制。
- 令牌由没有鉴权的管理接口签发、没有过期时间；完整的 OAuth 是后续工作。
