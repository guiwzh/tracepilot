# Local performance baseline

- Measured: 2026-08-12 (Asia/Shanghai)
- Runtime: Node.js v24.14.0
- Storage: SQLite WAL in a temporary local file
- Transport: Fastify `inject` in-process; no network or TLS cost

## SDK artifact

Run after `pnpm build`:

```bash
pnpm measure:sdk
```

| Artifact     |  Bytes |
| ------------ | -----: |
| Minified ESM | 12,502 |
| Gzip level 9 |  4,183 |

Source maps and type declarations are not included in these numbers.

## Server micro-benchmark

```bash
pnpm benchmark
```

The script writes 1,000 events as 100 sequential batches of 10. All events normalize into one issue,
with 200 distinct users. It then runs the first issue-list page 100 times.

| Operation          |     P50 |     P95 |
| ------------------ | ------: | ------: |
| Ingest batch of 10 | 1.79 ms | 2.23 ms |
| Issue list query   | 0.13 ms | 0.16 ms |

## Interpretation limits

This is a deterministic developer baseline, useful for detecting large regressions. It is not a load
test: there is no HTTP network, concurrent writer contention, authentication, remote disk, model call,
or production telemetry distribution. Do not use these values as capacity or SLA claims. A production
claim requires a named machine profile, concurrency schedule, warm-up, multiple runs, raw samples, and
networked deployment.
