# Stage 02 — Monitor SDK and incident playground

## Outcome

Delivered a plugin-based browser SDK and a purpose-built React incident lab. The SDK captures runtime,
promise, resource, Fetch, XHR, behavior, navigation, and Web Vital signals and transports them in
batches to the server.

## Implementation steps

1. Built an idempotent core lifecycle with plugin registration, user context, breadcrumbs, sampling,
   `beforeSend`, error deduplication, flush, and complete teardown.
2. Implemented separate error, promise, resource, network, behavior, performance, and transport plugins.
3. Preserved original Fetch/XHR/history functions and restored them during teardown, preventing duplicate
   listeners during repeated initialization.
4. Captured the original Fetch implementation before instrumentation, tagged SDK requests, and excluded
   the ingest endpoint to prevent recursive telemetry.
5. Added an in-memory batch queue, interval/size flush, exponential retry, keepalive Fetch, and page-hide
   `sendBeacon` delivery.
6. Implemented LCP, INP, CLS, FCP, and TTFB collection with browser capability fallbacks.
7. Built an accessible responsive Playground with controlled triggers for each target failure and SPA
   route breadcrumbs.

## Validation

```bash
pnpm --filter @trace-pilot/monitor-sdk typecheck
pnpm --filter @trace-pilot/monitor-sdk test
pnpm --filter @trace-pilot/monitor-sdk build
pnpm --filter @trace-pilot/playground typecheck
pnpm --filter @trace-pilot/playground build
```

Result: 4 SDK tests passed. ESM and CommonJS packages built successfully. The final verified minified
ESM artifact is 12,502 bytes and 4,183 bytes when gzip-compressed on this machine; the number is recorded as a local build
measurement, not a production benchmark.

## Key choices

- Successful HTTP spans become evidence without creating issues; failure classification stays server-side.
- Unsupported PerformanceObserver entry types fail silently because browser support is expected to vary.
- The Playground uses fictional checkout incidents and never needs real customer data.
