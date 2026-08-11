# Stage 00 — Project foundation

## Outcome

Established the TracePilot pnpm workspace, common TypeScript/lint/format rules, shared runtime schemas,
privacy helpers, environment template, and architecture records.

## Implementation steps

1. Created workspace scripts for parallel development and repository-wide verification.
2. Added strict TypeScript and ESLint flat configuration shared by all packages.
3. Defined the monitor envelope, issue state, and evidence diagnosis schemas with Zod.
4. Added common API/domain types so clients do not duplicate server response contracts.
5. Implemented recursive sensitive-field redaction and URL query removal with unit coverage.
6. Recorded the local-first architecture and event transport contract.

## Validation

```bash
pnpm --filter @trace-pilot/shared typecheck
pnpm --filter @trace-pilot/shared test
pnpm --filter @trace-pilot/shared build
```

## Deliberate trade-offs

- Source package exports keep local development fast; production packaging is still verified by tsup.
- SQLite is selected for the runnable MVP, while storage details remain inside the server application.
- The shared event payload is extensible but the surrounding envelope is strict.
