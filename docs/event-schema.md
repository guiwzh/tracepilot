# Event envelope

The SDK sends batches to `POST /api/v1/envelopes`.

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

The authoritative validation rules live in `packages/shared/src/schemas.ts`. The server rejects an
entire malformed envelope, removes URL query strings, and redacts secret-shaped keys before writing.
`eventId` is the ingestion idempotency key.
