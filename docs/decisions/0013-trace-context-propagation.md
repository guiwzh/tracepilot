# ADR 0013：用 W3C traceparent 把前端事件和后端链路连起来

- 状态：已采纳
- 日期：2026-10-02

## 背景

前端最常见的一类问题是「接口返回的数据不对，页面在上面崩了」：`cart.summary` 是 undefined、支付接口 503。
前端事件里只有请求的地址、状态码和耗时，后端为什么这么返回，要去后端的链路系统（OpenTelemetry + Jaeger / Tempo、
SkyWalking）里找。没有共同的 id，只能按时间和地址猜是哪一次请求；排障 Agent 也只能写「缺后端日志」。

业界的做法是让前端在请求上带链路上下文：Sentry 的 `tracePropagationTargets`、Datadog RUM 的 `allowedTracingUrls`、
OpenTelemetry Web 的 `propagateTraceHeaderCorsUrls`。格式上 W3C Trace Context（`traceparent` 头）是后端链路系统的共同标准。

## 决策

1. **SDK 给请求加 `traceparent: 00-<trace id>-<span id>-01`**，范围由 `tracePropagationTargets` 决定。
   默认只有同源请求：跨域请求带自定义头会先发 CORS 预检，对方没在 `Access-Control-Allow-Headers` 里放行
   `traceparent` 时请求直接失败，trace id 也不该发给第三方。配置后以配置为准；字符串是 URL 前缀（`new URL` 规范化后比较，
   不做子串匹配，`api.example.com.evil.net` 不会误中），正则测试完整 URL、同源请求还测试路径。`[]` 关闭。
2. **一次页面浏览一个 trace**，路由（去掉查询参数的地址，hash 路由算在内）变了换新的；每个请求一个新的 span id。
   采样标志固定为 01，按父 span 采样的后端会保留这些 trace。
3. **不覆盖已有的 `traceparent`**（应用自己或 OpenTelemetry Web 加的），记下它带的 id。fetch 复制请求头、换一个新的
   init，不改调用方的对象；XHR 读不到已设置的头，包装 `setRequestHeader` 得知应用加过没有。`no-cors` 请求不加：
   浏览器会悄悄丢掉这个头，记下来的 trace 后端根本没收到。
4. **事件带 `traceId`，前提是这次页面浏览里已经有请求把它带给了后端**；失败请求的事件带请求自己的 trace。
   网络面包屑记下每个请求的 `traceId` / `spanId`。指标样本不带。
5. **服务端存 `events.trace_id`**（部分索引，只收有值的行）。Issue 搜索框输入 32 位 trace id 时按 trace 找：
   后端拿着日志里的 trace id 能搜到这次页面浏览里出的前端问题；MCP 的 `list_issues` 同样支持。
6. **工作台显示 trace id**（Issue 头部、Network 标签每个请求），配置 `VITE_TRACE_URL_TEMPLATE` 后可以直接打开链路系统。
7. **排障 Agent 拿到 trace id**：`get_event_detail` 给出事件的 trace，失败请求后面附 `[trace … span …]`。
   提示词（`investigation-v4`）要求在 missingInformation 里点名要看的 trace，而不是猜后端做了什么——
   Agent 读不到链路系统。

## 替代方案

- **默认给所有请求加头**：跨域接口和第三方服务会因为预检失败而直接坏掉，监控 SDK 不能让业务请求失败。
- **每个请求一个 trace**：看不出同一个页面里的请求是一起发出的；后端搜到一个 trace 也只对应一个请求。
- **整个页面生命周期一个 trace**：单页应用开几个小时，一个 trace 攒下成千上万个请求，链路系统难以展示。
- **SDK 自己上报 span（做前端链路追踪）**：TracePilot 不是链路系统，存储、采样、展示都要从头做；
  只传播上下文、把链接交给已有的链路系统，是前端监控与后端可观测性之间最便宜的接缝。
- **事件总是带当前 trace id**：页面里还没有请求带过它时，后端从没见过这个 trace，工作台给出的链接打开是空的。
- **接一个链路系统的查询工具给 Agent**：要为 Jaeger、Tempo、SkyWalking 各写一套适配和权限；先把 trace id 准确交给人。

## 影响

- SDK 体积：产物 +816 B、接入成本 +840 B gzip（`pnpm measure:sdk`）。
- 接入方要在跨域的后端放行 `traceparent`；同源接口不需要任何改动。
- 事件 Schema 多一个可选字段，旧 SDK 不受影响；服务端迁移 9 加一列和一个部分索引。
- 排障提示词升到 `investigation-v4`。
