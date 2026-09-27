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

## 传输约定

- **Content-Type**：SDK 以 `text/plain;charset=UTF-8` 发送 JSON。它是 CORS 安全列表类型，跨域上报不触发
  预检；页面退出时的 `sendBeacon` 也因此不需要带凭据的预检。服务端同时接受 `application/json`，
  只在接入路由的封装作用域里把 `text/plain` 解析为 JSON（`apps/server/src/routes/events.ts`）。
- **大小**：单个事件序列化后不超过 32 KB（超出时 SDK 先截断超长字符串、再从最旧一端裁剪 breadcrumb，
  并在 `payload` 上标记 `truncated` / `trimmedBreadcrumbs`）；页面退出时每块不超过 60 KB，以适应浏览器
  64 KiB 的 keepalive / beacon 在途配额；服务端请求体上限 1 MiB。
- **投递语义**：至少一次。同一事件可能被 beacon、在途请求和下次加载的补发重复送达。

## 服务端处理

- `eventId` 是幂等键：已存在的事件计入 `duplicates` 并跳过。
- Web Vitals 事件带 `payload.metricId`（来自 web-vitals 的 `metric.id`）。同一指标实例再次上报时按
  `metricId` **覆盖**而不是追加，以采集时间为准，迟到的旧值不会覆盖新值；响应里计入 `metricUpdates`。
- 整个信封在一个事务里写入；格式错误的信封整体拒绝（400），DSN 与项目不匹配返回 403。
- 写入前移除 URL 查询字符串，并遮蔽具有敏感信息特征的字段（`packages/shared/src/redaction.ts`）。

响应示例：`{ "accepted": 9, "duplicates": 1, "metricUpdates": 0, "issueIds": ["..."] }`（HTTP 202）。
