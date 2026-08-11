# ADR 0002: Read-only, evidence-grounded diagnosis

- Status: accepted
- Date: 2026-08-12

## Decision

The diagnosis boundary receives a compact, twice-redacted snapshot of stored issue evidence and may
only return a schema-validated report. It has no shell, filesystem, repository, browser, or mutation
tools. The application remains fully usable without an external model key by using a deterministic
local evidence engine whose output follows the same public schema and is visibly labeled as such.

For OpenAI, use the Responses API with `text.format` and the JavaScript SDK's Zod parser. Validate the
returned value again with the shared Zod schema before persistence.

## Consequences

- A model outage cannot block issue ingestion or investigation.
- Every possible cause includes confidence and supporting evidence; unknowns are explicit.
- A SHA-256 hash of prompt version plus redacted context provides safe reuse for unchanged evidence.
- Regeneration updates the cached record instead of creating unbounded duplicates.
- This MVP cannot autonomously verify or repair a diagnosis, by design.
