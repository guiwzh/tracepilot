# ADR 0001: TypeScript workspace and local-first runtime

- Status: accepted
- Date: 2026-08-12

## Decision

Use a pnpm TypeScript workspace with source-level package exports during development. Use Fastify and
SQLite for a zero-service local runtime, while keeping shared wire schemas in a package imported by
the SDK, server, and dashboard.

## Consequences

- A contributor can run the full product without Docker or a separate database.
- Zod schemas prevent the three TypeScript surfaces from silently drifting.
- SQLite-specific aggregate queries are acceptable in the MVP; storage migration remains isolated to
  the server.
- Each package still emits a production build so source-level exports do not hide packaging errors.
