# Stage 04 — Source maps and evidence diagnosis

## Outcome

Closed the product loop from a minified browser stack to original source coordinates and from stored
telemetry to a cached, structured diagnosis. Both features degrade explicitly without affecting core
issue investigation.

## Implementation steps

1. Added private multipart source-map uploads with a 10 MB limit, `.map` extension check, version 3
   structure validation, random server-side filenames, and restrictive file permissions.
2. Normalized browser asset URLs to release-scoped filenames and mapped stack line/column pairs with
   `source-map` consumers.
3. Reprocessed stored release events after map upload and mapped new events immediately when a matching
   map already existed.
4. Built compact diagnosis context from the issue, mapped/minified stack, eight recent event samples,
   twelve breadcrumbs per sample, failed requests, release, browser, and project-scoped performance.
5. Applied recursive secret redaction again immediately before hashing or model use.
6. Implemented a deterministic local evidence engine so demos and tests need no key or network access.
7. Added an optional OpenAI Responses API adapter using Zod-backed `text.format` structured outputs,
   a 30-second timeout, no SDK retries, and a final shared-schema validation.
8. Persisted model, prompt version, context hash, tokens, latency, result, and cache state.
9. Returned isolated 502 errors for provider failures while issue APIs remain independent.

## Validation

```bash
pnpm --filter @trace-pilot/server typecheck
pnpm --filter @trace-pilot/server test
pnpm --filter @trace-pilot/server build
```

Result: 8 tests passed, including release-scoped source mapping, missing-map fallback, schema-valid local
diagnosis, and unchanged-context cache reuse. The complete diagnosis report was also rendered against
the local server and visually checked at 1440×1200.

## Key choices

- Source maps are never exposed through a download endpoint.
- Context size is bounded before model invocation rather than relying on the provider limit.
- External structured output and local Zod validation are intentionally redundant trust boundaries.
