import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  diagnosisResultSchema,
  PROMPT_VERSION,
  redactSensitive,
  type DiagnosisRecord,
  type DiagnosisResult,
  type StoredEvent,
} from '@trace-pilot/shared';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { parseJson } from '../lib/json';
import { getIssue, listIssueEvents } from './queries';

interface DiagnosisContext {
  issue: {
    title: string;
    message: string;
    count: number;
    affectedUsers: number;
    firstSeenAt: string;
    lastSeenAt: string;
    status: string;
  };
  stack: { minified?: string; original?: string };
  recentEvents: Array<{
    pageUrl: string;
    release: string;
    browser: string;
    breadcrumbs: StoredEvent['breadcrumbs'];
    failedRequests: Array<Record<string, unknown>>;
  }>;
  performance?: { lcp?: number; inp?: number; cls?: number };
}

interface ModelResult {
  result: DiagnosisResult;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function failedRequests(event: StoredEvent): Array<Record<string, unknown>> {
  return event.breadcrumbs
    .filter((item) => item.type === 'network' && Number(item.data?.status ?? 0) >= 400)
    .slice(-5)
    .map((item) => ({
      method: item.data?.method,
      url: item.data?.url,
      status: item.data?.status,
      duration: item.data?.duration,
    }));
}

export function buildDiagnosisContext(database: TraceDatabase, issueId: string): DiagnosisContext | null {
  const issue = getIssue(database, issueId);
  if (!issue) return null;
  const events = listIssueEvents(database, issueId, 8);
  const sample = events[0];
  const context: DiagnosisContext = {
    issue: {
      title: issue.title,
      message: sample?.message ?? issue.title,
      count: issue.eventCount,
      affectedUsers: issue.userCount,
      firstSeenAt: new Date(issue.firstSeenAt).toISOString(),
      lastSeenAt: new Date(issue.lastSeenAt).toISOString(),
      status: issue.status,
    },
    stack: {
      minified: sample?.stack ?? undefined,
      original: sample?.originalStack ?? undefined,
    },
    recentEvents: events.map((event) => ({
      pageUrl: event.pageUrl,
      release: event.context.release,
      browser: event.context.device.userAgent,
      breadcrumbs: event.breadcrumbs.slice(-12),
      failedRequests: failedRequests(event),
    })),
  };
  const metrics = database.sqlite
    .prepare(
      `SELECT json_extract(context_json, '$.payload.metric') metric,
        json_extract(context_json, '$.payload.value') value
       FROM events e JOIN releases r ON r.id = e.release_id
       WHERE e.type = 'performance' AND r.project_id = ?
       ORDER BY e.created_at DESC LIMIT 30`,
    )
    .all(issue.projectId) as Array<{ metric?: string; value?: number }>;
  const performance: DiagnosisContext['performance'] = {};
  for (const metric of metrics) {
    if (metric.metric === 'LCP' && performance.lcp === undefined) performance.lcp = Number(metric.value);
    if (metric.metric === 'INP' && performance.inp === undefined) performance.inp = Number(metric.value);
    if (metric.metric === 'CLS' && performance.cls === undefined) performance.cls = Number(metric.value);
  }
  if (Object.keys(performance).length > 0) context.performance = performance;
  return redactSensitive(context);
}

function evidenceFromContext(context: DiagnosisContext): DiagnosisResult['evidence'] {
  const evidence: DiagnosisResult['evidence'] = [];
  const stack = context.stack.original ?? context.stack.minified;
  if (stack) {
    const frame = stack.split('\n').find((line) => line.includes(' at '))?.trim() ?? stack.split('\n')[0]!;
    evidence.push({ description: `Captured stack points to ${frame}`, source: 'stack' });
  }
  const failed = context.recentEvents.flatMap((event) => event.failedRequests)[0];
  if (failed) {
    evidence.push({
      description: `${String(failed.method ?? 'Request')} ${String(failed.url ?? 'unknown URL')} returned ${String(failed.status ?? 'an error')}.`,
      source: 'network',
    });
  }
  const click = [...context.recentEvents.flatMap((event) => event.breadcrumbs)]
    .reverse()
    .find((item) => item.type === 'click');
  if (click) evidence.push({ description: `The last captured user action was ${click.message}.`, source: 'breadcrumb' });
  const release = context.recentEvents[0]?.release;
  if (release) evidence.push({ description: `The most recent samples occurred on release ${release}.`, source: 'release' });
  if (context.performance?.lcp !== undefined) {
    evidence.push({ description: `Recent LCP evidence is ${context.performance.lcp} ms.`, source: 'performance' });
  }
  return evidence.slice(0, 6);
}

function localDiagnosis(context: DiagnosisContext): DiagnosisResult {
  const lower = context.issue.title.toLowerCase();
  const evidence = evidenceFromContext(context);
  let causes: DiagnosisResult['possibleCauses'];
  let suggestions: string[];
  if (/→\s*(?:5\d\d|failed)|network|request/.test(lower)) {
    causes = [
      { cause: 'The upstream endpoint was unavailable or rejected the request.', confidence: 0.88, supportingEvidence: evidence.filter((item) => item.source === 'network').map((item) => item.description) },
      { cause: 'A client retry or timeout policy amplified a transient service failure.', confidence: 0.46, supportingEvidence: [`${context.issue.count} events were grouped for this failure.`] },
    ];
    suggestions = ['Handle the failing status explicitly and keep the user action retryable.', 'Correlate the endpoint status with service logs for the same release window.', 'Add a bounded backoff only for idempotent requests.'];
  } else if (/resource|chunk|load/.test(lower)) {
    causes = [
      { cause: 'The deployed HTML referenced an asset that was absent or no longer cached at the CDN.', confidence: 0.81, supportingEvidence: evidence.filter((item) => item.source === 'release' || item.source === 'stack').map((item) => item.description) },
      { cause: 'A release transition left a stale page pointing at an older dynamic chunk.', confidence: 0.64, supportingEvidence: [`The issue spans ${context.issue.count} captured loads.`] },
    ];
    suggestions = ['Retain immutable assets for the maximum HTML cache lifetime.', 'Offer one guarded page refresh after a dynamic import failure.', 'Compare CDN asset availability for the affected release.'];
  } else {
    causes = [
      { cause: 'The runtime received a state shape that the failing code path did not guard.', confidence: 0.82, supportingEvidence: evidence.filter((item) => item.source === 'stack' || item.source === 'breadcrumb').map((item) => item.description) },
      { cause: 'A release changed the response or initialization timing before this action.', confidence: 0.53, supportingEvidence: evidence.filter((item) => item.source === 'release').map((item) => item.description) },
    ];
    suggestions = ['Guard the nullable value at the mapped source frame and preserve a safe UI state.', 'Add a fixture for the missing data shape to the unit test around this path.', 'Compare payload shape and initialization order with the prior release.'];
  }

  return {
    summary: `${context.issue.title} affected ${context.issue.affectedUsers} users across ${context.issue.count} captured events; the leading explanation below is an evidence-bound hypothesis.`,
    evidence,
    possibleCauses: causes,
    investigationSteps: [
      'Open the mapped top stack frame and inspect the value assumptions on that line.',
      'Compare recent samples by release, route, and browser before narrowing the cause.',
      'Reproduce the last captured user action with the same failed-request response.',
    ],
    suggestions,
    missingInformation: [
      context.stack.original ? 'A correlated backend trace or request ID.' : 'The matching source map for the affected release.',
      'The expected response or state schema at the failing boundary.',
    ],
    disclaimer: 'This diagnosis is a read-only hypothesis generated from captured evidence. No code, command, or production state was changed or verified.',
  };
}

const SYSTEM_PROMPT = `You diagnose frontend production incidents using only the supplied JSON evidence.
Return one JSON object matching the requested schema. Every cause must cite supplied evidence and include a confidence from 0 to 1.
Never invent a file, function, request, release, or verification. Put unknowns in missingInformation.
Do not claim to have run code, commands, tests, or changed any system. Keep the diagnosis concise and actionable.`;

async function callModel(config: ServerConfig, context: DiagnosisContext): Promise<ModelResult> {
  if (!config.modelApiKey || !config.modelApiUrl) {
    const result = diagnosisResultSchema.parse(localDiagnosis(context));
    return {
      result,
      model: 'local-evidence-engine',
      inputTokens: Math.ceil(JSON.stringify(context).length / 4),
      outputTokens: Math.ceil(JSON.stringify(result).length / 4),
    };
  }
  const baseURL = config.modelApiUrl.replace(/\/(?:chat\/completions|responses)\/?$/, '');
  const client = new OpenAI({
    apiKey: config.modelApiKey,
    baseURL,
    timeout: 30_000,
    maxRetries: 0,
  });
  const response = await client.responses.parse({
    model: config.modelName,
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Evidence context:\n${JSON.stringify(context)}\n\nReturn a diagnosis grounded only in this context.`,
      },
    ],
    text: { format: zodTextFormat(diagnosisResultSchema, 'diagnosis_result') },
  });
  if (!response.output_parsed) throw new Error('MODEL_EMPTY_OR_REFUSED_RESPONSE');
  return {
    result: diagnosisResultSchema.parse(response.output_parsed),
    model: config.modelName,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function mapDiagnosis(row: Record<string, unknown>, cached = false): DiagnosisRecord {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    model: String(row.model),
    inputHash: String(row.input_hash),
    result: diagnosisResultSchema.parse(parseJson(String(row.result_json), {})),
    promptVersion: String(row.prompt_version),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    latencyMs: Number(row.latency_ms),
    createdAt: Number(row.created_at),
    cached,
  };
}

export function listDiagnoses(database: TraceDatabase, issueId: string): DiagnosisRecord[] {
  const rows = database.sqlite
    .prepare('SELECT * FROM diagnoses WHERE issue_id = ? ORDER BY created_at DESC')
    .all(issueId) as Array<Record<string, unknown>>;
  return rows.map((row) => mapDiagnosis(row));
}

export function getDiagnosis(database: TraceDatabase, diagnosisId: string): DiagnosisRecord | null {
  const row = database.sqlite.prepare('SELECT * FROM diagnoses WHERE id = ?').get(diagnosisId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapDiagnosis(row) : null;
}

export async function diagnoseIssue(
  database: TraceDatabase,
  config: ServerConfig,
  issueId: string,
  force = false,
): Promise<DiagnosisRecord | null> {
  const context = buildDiagnosisContext(database, issueId);
  if (!context) return null;
  const inputHash = createHash('sha256')
    .update(`${PROMPT_VERSION}|${JSON.stringify(context)}`)
    .digest('hex');
  const existing = database.sqlite
    .prepare('SELECT * FROM diagnoses WHERE issue_id = ? AND input_hash = ?')
    .get(issueId, inputHash) as Record<string, unknown> | undefined;
  if (existing && !force) return mapDiagnosis(existing, true);

  const startedAt = performance.now();
  const generated = await callModel(config, context);
  const latencyMs = Math.round(performance.now() - startedAt);
  const id = existing ? String(existing.id) : randomUUID();
  const createdAt = Date.now();
  database.sqlite
    .prepare(
      `INSERT INTO diagnoses
       (id, issue_id, model, input_hash, result_json, prompt_version, input_tokens, output_tokens, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, input_hash) DO UPDATE SET
         model = excluded.model, result_json = excluded.result_json,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         latency_ms = excluded.latency_ms, created_at = excluded.created_at`,
    )
    .run(
      id,
      issueId,
      generated.model,
      inputHash,
      JSON.stringify(generated.result),
      PROMPT_VERSION,
      generated.inputTokens,
      generated.outputTokens,
      latencyMs,
      createdAt,
    );
  return {
    id,
    issueId,
    model: generated.model,
    inputHash,
    result: generated.result,
    promptVersion: PROMPT_VERSION,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
    latencyMs,
    createdAt,
    cached: false,
  };
}
