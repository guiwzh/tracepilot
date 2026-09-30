# 事件信封格式

SDK 把事件批次发送到 `POST /api/v1/envelopes`，一个信封最多 100 个事件。

```json
{
  "dsnKey": "demo-dsn-key",
  "sentAt": 1770000000000,
  "events": [
    {
      "eventId": "019...",
      "eventType": "error",
      "timestamp": 1770000000000,
      "projectId": "demo-project",
      "release": "2.4.1",
      "environment": "production",
      "page": { "url": "https://shop.example/checkout", "route": "/checkout" },
      "device": { "userAgent": "...", "language": "en-US" },
      "payload": { "name": "TypeError", "message": "cart.items is undefined", "stack": "..." },
      "breadcrumbs": []
    }
  ]
}
```

权威校验规则在 `packages/shared/src/schemas.ts`，SDK 与服务端共用同一份 Zod 定义。

## 哪些信号成为事件

- `error`：运行时异常、未处理的 Promise rejection、React 根节点错误回调（`reactErrorHandler`）
  转交的渲染错误，以及 `captureException` / `captureMessage`。默认忽略 `Script error.`、
  ResizeObserver 循环告警和浏览器扩展里的报错。
- `resource`：图片、脚本、样式表、媒体加载失败。
- `network`：**只有失败的请求**（状态码 ≥ 400 或网络错误）。成功的请求、被取消的请求和 no-cors 的
  opaque 响应只记成 breadcrumb，作为之后错误的上下文。
- `performance`：Web Vitals 样本，**不附带 breadcrumb**——它们不属于任何 Issue 的证据链。

同一签名的 `error`、`resource`、`network` 事件在短窗口（默认 5 秒）内只发送第一条。窗口从上一次发送算起，
一直在发生的问题每个窗口至少发送一次。资源与请求的签名去掉查询参数并把数字归一，只差编号的一批资源或接口
视为同一处。

## 传输约定

- **Content-Type**：SDK 以 `text/plain;charset=UTF-8` 发送 JSON。它是 CORS 安全列表类型，跨域上报不触发
  预检；页面退出时的 `sendBeacon` 也因此不需要带凭据的预检。服务端同时接受 `application/json`，
  只在接入路由的封装作用域里把 `text/plain` 解析为 JSON（`apps/server/src/routes/events.ts`）。
- **大小**：单个事件序列化后不超过 32 KB（超出时 SDK 先截断超长字符串、再从最旧一端裁剪 breadcrumb，
  并在 `payload` 上标记 `truncated` / `trimmedBreadcrumbs`）；页面退出时每块不超过 60 KB，以适应浏览器
  64 KiB 的 keepalive / beacon 在途配额；服务端请求体上限 1 MiB。
- **投递语义**：至少一次。同一事件可能被 beacon 和在途请求各送达一次；服务端故障期间交给 beacon 的
  事件仍留在队列里，恢复后会再发一次。
- **重试与退避**：一批失败后在同一轮里快速重试（默认 2 次，间隔 100、200 ms）；仍失败则进入退避，
  自动发送的间隔为 `flushInterval × 2^(连续失败次数 − 1)`，上限 5 分钟，再乘 0.5～1 的随机系数。
  429 不做快速重试；服务端给出 `Retry-After` 时按它和退避中较晚的一个等待，显式 `flush()` 也遵守它。
  服务端通过 CORS 的 `Access-Control-Expose-Headers` 暴露 `Retry-After`，跨域的 SDK 才读得到。
- **页面退出**：按 60 KB 切块交给 `sendBeacon`，浏览器拒收的部分留在队列里。服务端正在失败时，交给
  beacon 只算多试一次，事件不移出队列；浏览器离线时不发送。发不完的事件不写入本地存储，页面真正卸载时丢失。
- **SDK 端脱敏**：事件交给 `beforeSend` 之前，页面地址、请求地址、breadcrumb 与 payload 已按与服务端相同的
  规则（`packages/shared/src/redaction.ts`）去掉 URL 查询参数和片段、遮蔽敏感字段；堆栈只删帧里的
  查询参数，保留行列号，服务端才能还原。点击 breadcrumb 只记录可交互元素上的文字，`data-tp-mask`
  标记的区域不记录文字。

## 服务端处理

- `eventId` 是幂等键：已存在的事件计入 `duplicates` 并跳过。
- **时间**：`timestamp` 和 breadcrumb 的时间来自用户设备的时钟。服务端收到的时间与 `sentAt` 相差超过
  1 分钟时，认为设备时钟不准，把事件和它的 breadcrumb 平移同样的量；平移后仍在未来的事件按收到的时间
  记录。重试后才送达的旧事件（`sentAt` 是这次发送的时间）不受影响。
- Web Vitals 事件带 `payload.metricId`（来自 web-vitals 的 `metric.id`）。同一指标实例再次上报时按
  `metricId` **覆盖**而不是追加，以采集时间为准，迟到的旧值不会覆盖新值；响应里计入 `metricUpdates`。
- 整个信封在一个事务里写入；格式错误的信封整体拒绝（400），DSN 与项目不匹配返回 403。
- 写入前移除 URL 查询字符串，并遮蔽具有敏感信息特征的字段（`packages/shared/src/redaction.ts`）；
  `stack` 与 `componentStack` 只删帧里的查询参数，保留行列号。
- **聚合**：错误按「类型 + 归一化后的消息 + 栈顶帧」的指纹归入 Issue，资源加载失败按地址，失败的请求按
  「方法 + 地址 + 状态码」；地址都去掉查询参数、把业务 ID 归一。已解决的 Issue 收到发生时间晚于解决时间的
  新事件时重新打开为未解决；已忽略的保持忽略。
- 带堆栈的新事件在入库之后按所在 Release 的 Source Map 还原，结果存为 `originalStack`；
  map 缺失、损坏或还原失败只会少这一项，不影响 202。

响应示例：`{ "accepted": 9, "duplicates": 1, "metricUpdates": 0, "issueIds": ["..."] }`（HTTP 202）。
