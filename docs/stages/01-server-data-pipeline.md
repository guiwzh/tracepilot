# Stage 01 — Server data pipeline

## Outcome

Delivered a runnable Fastify service backed by SQLite and Drizzle schemas. The service accepts browser
event batches, enforces the shared contract, redacts secrets, creates releases, aggregates actionable
events into issues, and exposes project, issue, event, overview, and performance APIs.

## Implementation steps

1. Created the relational project, release, issue, event, source-map, and diagnosis tables with foreign
   keys, uniqueness constraints, WAL mode, and query indexes.
2. Added a deterministic demo project so the repository works immediately after startup.
3. Implemented a one-transaction envelope ingest path with DSN/project authorization and event-ID
   idempotency.
4. Normalized UUIDs, long numeric IDs, chunk hashes, query strings, and whitespace before computing a
   SHA-256 issue fingerprint.
5. Aggregated first/last seen, event count, and distinct affected users while keeping performance
   samples outside the issue stream.
6. Added paginated/filterable issue queries, event details, browser/route/release distributions,
   project overview trends, release management, and Web Vital percentiles.
7. Added stable JSON error responses and verified malformed input does not affect service health.

## Validation

```bash
pnpm --filter @trace-pilot/server typecheck
pnpm --filter @trace-pilot/server test
pnpm --filter @trace-pilot/server build
```

Result: 4 tests passed across fingerprint normalization and injected HTTP integration scenarios.

## Key choices

- SQLite transactions make each batch atomic and deterministic for the MVP.
- Successful network spans and performance samples remain queryable events without polluting issues.
- Complex dashboard aggregates use explicit SQL while Drizzle owns the typed table definitions and
  core inserts/updates.
