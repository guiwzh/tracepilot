# 3–5 minute demo script

## 0:00–0:35 — Establish the loop

Open the project selector, choose **Checkout Web**, and explain the path: browser signal → grouped issue
→ reconstructed evidence → source location → bounded diagnosis.

## 0:35–1:20 — Create a real signal

Open the Incident Playground at `http://localhost:4174`. Trigger **Fetch 503**, **SPA route change**, and
**Captured warning**, then flush the buffer. Point out that these controls use the same SDK exported by
the workspace, not hard-coded dashboard fixtures.

## 1:20–2:15 — Triage

Return to Issues. Filter severity and show that the query lives in the URL. Open the payment 503 issue
and identify count, affected users, latest release, route, browser share, and the indexed evidence chain.

## 2:15–3:00 — Source boundary

Open Stack and Releases. Explain that minified filename plus Release selects a private source map; a
missing map preserves the raw stack and clearly reports the fallback. Optionally upload the source-map
fixture used by the unit test.

## 3:00–4:00 — Diagnosis

Open Diagnosis and generate a report. Show evidence citations, confidence bars, investigation steps,
missing information, model/Token/latency metadata, and the read-only disclaimer. Generate it again to
demonstrate the unchanged-context cache.

## 4:00–4:40 — Engineering proof

Run `pnpm verify`, `pnpm test:e2e`, `pnpm benchmark`, and `pnpm evaluate:diagnosis`. Show that all resume
numbers point to reproducible scripts and reports, and state that the local micro-benchmark is not a
production SLA.
