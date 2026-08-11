# 事件信封格式

SDK 将事件批次发送至 `POST /api/v1/envelopes`。

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

权威校验规则位于 `packages/shared/src/schemas.ts`。服务端会拒绝整个格式错误的信封，在写入前
移除 URL 查询字符串，并遮蔽具有敏感信息特征的字段。`eventId` 是事件接入的幂等键。
