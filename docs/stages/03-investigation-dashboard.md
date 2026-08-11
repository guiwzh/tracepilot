# Stage 03 — Investigation dashboard

## Outcome

Delivered the React evidence console: project selection, issue triage, shareable filters, project trends,
issue details, source traces, chronological breadcrumbs, network evidence, event samples, performance
percentiles, releases, private source-map upload UI, and evidence-grounded diagnosis presentation.

## Implementation steps

1. Added TanStack Query for cached API state, URL search parameters for shareable issue views, and a
   persisted Zustand preference for row density.
2. Built project creation/selection and a responsive application shell with project-aware navigation.
3. Implemented server-paginated issue filters, sortable freshness, severity/status marks, sparklines,
   overview metrics, and an hourly ECharts trend.
4. Created the issue investigation surface with overview, stack, breadcrumbs, network, event, and AI
   diagnosis tabs.
5. Designed the chronological “evidence chain” as the product's signature interaction: every captured
   action receives a stable evidence index, source label, timestamp, and optional structured payload.
6. Added source-map resolution states, browser distribution, Web Vital percentile cards, release
   creation, and upload controls.
7. Added a deterministic seed command that generates 307 fictional browser events across releases,
   browsers, routes, users, failures, and performance metrics.
8. Lazy-loaded investigation routes and split the chart runtime into a non-initial vendor chunk.
9. Normalized volatile IDs in issue titles while preserving readable capitalization.

## Validation

```bash
pnpm --filter @trace-pilot/server test
pnpm seed
pnpm --filter @trace-pilot/dashboard typecheck
pnpm --filter @trace-pilot/dashboard test
pnpm --filter @trace-pilot/dashboard build
```

Result: 5 server tests and 1 dashboard formatting test passed. Production chunks built successfully.
The issue list and detail views were rendered against the real local API at 1440×1000 and 390×844;
both had zero document-level horizontal overflow.

## Visual direction

The interface borrows from an aviation investigation desk rather than a generic neon monitoring wall:
cold blue-gray surfaces, orange incident signals, mono evidence labels, dense but quiet tables, and one
continuous chain connecting the facts around an error. Motion is limited and reduced-motion is honored.
