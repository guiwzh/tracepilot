# Diagnosis smoke evaluation

- Measured: 2026-08-12 (Asia/Shanghai)
- Engine: `local-evidence-engine`
- Dataset: 4 deterministic fictional seeded issues

```bash
pnpm evaluate:diagnosis
```

| Contract metric                       |       Result |
| ------------------------------------- | -----------: |
| Structured output success             | 4 / 4 (100%) |
| Cache hit on identical second request | 4 / 4 (100%) |
| Average evidence items                |         3.75 |
| Average possible causes               |         2.00 |

## What this proves

- Every generated record conforms to the shared Zod schema.
- Each fixed scenario returns labeled evidence and multiple confidence-scored hypotheses.
- Prompt-version plus redacted-context hashing reuses unchanged results.

## What this does not prove

This deterministic smoke suite does not measure semantic model quality, human usefulness, recall, or
hallucination under an external provider. Before claiming those metrics, add 20–30 independently labeled
incidents, human rubrics, blind scoring, provider/model snapshots, repeated trials, refusal handling,
latency, and Token/cost collection. The repository deliberately reports this limitation instead of
inventing an AI quality number.
