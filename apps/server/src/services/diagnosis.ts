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

/**
 * 诊断服务只接收经过裁剪和脱敏的证据快照，不把数据库、文件系统或命令工具交给模型。
 * 外部模型不可用时使用确定性的本地引擎，监控主链路不受影响。
 */
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
  /** 实际走通的结构化输出通道，用于日志与评测，不进入数据库。 */
  transport: ModelTransport | 'local';
  inputTokens: number;
  outputTokens: number;
}

function failedRequests(event: StoredEvent): Array<Record<string, unknown>> {
  // 只保留最近 5 个失败请求和少量字段，控制模型输入大小并排除请求体。
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

export function buildDiagnosisContext(
  database: TraceDatabase,
  issueId: string,
): DiagnosisContext | null {
  const issue = getIssue(database, issueId);
  if (!issue) return null;
  // 上下文有明确上限：最近 8 个事件，每个事件最后 12 条 Breadcrumb。
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
  // 查询按时间倒序，因此每种指标第一次出现的值就是最新样本。
  for (const metric of metrics) {
    if (metric.metric === 'LCP' && performance.lcp === undefined)
      performance.lcp = Number(metric.value);
    if (metric.metric === 'INP' && performance.inp === undefined)
      performance.inp = Number(metric.value);
    if (metric.metric === 'CLS' && performance.cls === undefined)
      performance.cls = Number(metric.value);
  }
  if (Object.keys(performance).length > 0) context.performance = performance;
  // 这是入库脱敏之后的第三道防线，防止历史脏数据进入外部模型。
  return redactSensitive(context);
}

function evidenceFromContext(context: DiagnosisContext): DiagnosisResult['evidence'] {
  // 本地引擎也生成带 source 枚举的引用，使 UI 和外部模型输出使用同一契约。
  const evidence: DiagnosisResult['evidence'] = [];
  const stack = context.stack.original ?? context.stack.minified;
  if (stack) {
    const frame =
      stack
        .split('\n')
        .find((line) => line.includes(' at '))
        ?.trim() ?? stack.split('\n')[0]!;
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
  if (click)
    evidence.push({
      description: `The last captured user action was ${click.message}.`,
      source: 'breadcrumb',
    });
  const release = context.recentEvents[0]?.release;
  if (release)
    evidence.push({
      description: `The most recent samples occurred on release ${release}.`,
      source: 'release',
    });
  if (context.performance?.lcp !== undefined) {
    evidence.push({
      description: `Recent LCP evidence is ${context.performance.lcp} ms.`,
      source: 'performance',
    });
  }
  return evidence.slice(0, 6);
}

function localDiagnosis(context: DiagnosisContext): DiagnosisResult {
  // 这是可重复的规则型降级结果，用于离线演示和契约测试，不伪装成大模型推理。
  const lower = context.issue.title.toLowerCase();
  const evidence = evidenceFromContext(context);
  let causes: DiagnosisResult['possibleCauses'];
  let suggestions: string[];
  if (/→\s*(?:5\d\d|failed)|network|request/.test(lower)) {
    causes = [
      {
        cause: 'The upstream endpoint was unavailable or rejected the request.',
        confidence: 0.88,
        supportingEvidence: evidence
          .filter((item) => item.source === 'network')
          .map((item) => item.description),
      },
      {
        cause: 'A client retry or timeout policy amplified a transient service failure.',
        confidence: 0.46,
        supportingEvidence: [`${context.issue.count} events were grouped for this failure.`],
      },
    ];
    suggestions = [
      'Handle the failing status explicitly and keep the user action retryable.',
      'Correlate the endpoint status with service logs for the same release window.',
      'Add a bounded backoff only for idempotent requests.',
    ];
  } else if (/resource|chunk|load/.test(lower)) {
    causes = [
      {
        cause:
          'The deployed HTML referenced an asset that was absent or no longer cached at the CDN.',
        confidence: 0.81,
        supportingEvidence: evidence
          .filter((item) => item.source === 'release' || item.source === 'stack')
          .map((item) => item.description),
      },
      {
        cause: 'A release transition left a stale page pointing at an older dynamic chunk.',
        confidence: 0.64,
        supportingEvidence: [`The issue spans ${context.issue.count} captured loads.`],
      },
    ];
    suggestions = [
      'Retain immutable assets for the maximum HTML cache lifetime.',
      'Offer one guarded page refresh after a dynamic import failure.',
      'Compare CDN asset availability for the affected release.',
    ];
  } else {
    causes = [
      {
        cause: 'The runtime received a state shape that the failing code path did not guard.',
        confidence: 0.82,
        supportingEvidence: evidence
          .filter((item) => item.source === 'stack' || item.source === 'breadcrumb')
          .map((item) => item.description),
      },
      {
        cause: 'A release changed the response or initialization timing before this action.',
        confidence: 0.53,
        supportingEvidence: evidence
          .filter((item) => item.source === 'release')
          .map((item) => item.description),
      },
    ];
    suggestions = [
      'Guard the nullable value at the mapped source frame and preserve a safe UI state.',
      'Add a fixture for the missing data shape to the unit test around this path.',
      'Compare payload shape and initialization order with the prior release.',
    ];
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
      context.stack.original
        ? 'A correlated backend trace or request ID.'
        : 'The matching source map for the affected release.',
      'The expected response or state schema at the failing boundary.',
    ],
    disclaimer:
      'This diagnosis is a read-only hypothesis generated from captured evidence. No code, command, or production state was changed or verified.',
  };
}

const SYSTEM_PROMPT = `You diagnose frontend production incidents using only the supplied JSON evidence.
Return one JSON object matching the requested schema. Every cause must cite supplied evidence and include a confidence from 0 to 1.
Never invent a file, function, request, release, or verification. Put unknowns in missingInformation.
Do not claim to have run code, commands, tests, or changed any system. Keep the diagnosis concise and actionable.`;

function userPrompt(context: DiagnosisContext): string {
  return `Evidence context:\n${JSON.stringify(context)}\n\nReturn a diagnosis grounded only in this context.`;
}

/**
 * OpenAI 兼容端点对结构化输出的支持并不一致，而且不一定按直觉分布：
 * 实测 DeepSeek 支持 Responses API 的 `text.format` 严格 json_schema，
 * 却拒绝 `chat/completions` 的 `json_schema`（400 "This response_format type is unavailable now"）。
 *
 * 因此这里按端点能力降级，而不是按厂商名字硬编码：
 *   1. Responses API + Zod 结构化输出——能力最强，模型侧就保证了形状。
 *   2. chat/completions + `json_object` + 提示词内嵌 schema——只保证是合法 JSON，形状靠校验兜底。
 *
 * 两条路径最终都会经过同一个共享 Zod Schema。这就是 ADR 0002 说的冗余信任边界：
 * 无论 Provider 承诺了什么，落库前的形状判断只认我们自己的契约。
 */
type ModelTransport = 'responses' | 'chat.completions';

// 能力探测结果按 (baseURL, model) 缓存在进程内，避免每次诊断都为不支持的端点白付一次往返。
const transportCache = new Map<string, ModelTransport>();

function indicatesUnsupportedEndpoint(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  // 404：端点根本不存在。400：端点在，但不接受这种结构化输出请求。
  if (status === 404) return true;
  if (status !== 400) return false;
  const message = String((error as { message?: string }).message ?? '').toLowerCase();
  return /response_format|text\.format|json_schema|unsupported|unavailable|not support/.test(
    message,
  );
}

async function viaResponses(
  client: OpenAI,
  config: ServerConfig,
  context: DiagnosisContext,
): Promise<ModelResult> {
  const response = await client.responses.parse({
    model: config.modelName,
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(context) },
    ],
    text: { format: zodTextFormat(diagnosisResultSchema, 'diagnosis_result') },
  });
  // Responses API 先按 Zod 格式解析，随后再 parse 一次作为持久化前的最终校验。
  if (!response.output_parsed) throw new Error('MODEL_EMPTY_OR_REFUSED_RESPONSE');
  return {
    result: diagnosisResultSchema.parse(response.output_parsed),
    model: config.modelName,
    transport: 'responses',
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

async function viaChatCompletions(
  client: OpenAI,
  config: ServerConfig,
  context: DiagnosisContext,
): Promise<ModelResult> {
  // schema 从同一个 Zod 定义生成，避免降级路径的提示词和契约各写一份而漂移。
  const { schema } = zodTextFormat(diagnosisResultSchema, 'diagnosis_result');
  const response = await client.chat.completions.create({
    model: config.modelName,
    messages: [
      {
        role: 'system',
        // json_object 模式要求提示词里出现 "JSON" 字样，同时也需要把形状讲清楚——
        // 这一档只保证返回合法 JSON，不保证符合 schema。
        content: `${SYSTEM_PROMPT}\n\nReturn JSON conforming exactly to this schema:\n${JSON.stringify(schema)}`,
      },
      { role: 'user', content: userPrompt(context) },
    ],
    response_format: { type: 'json_object' },
  });
  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('MODEL_EMPTY_OR_REFUSED_RESPONSE');
  // JSON.parse 与 Zod 校验都可能抛错，最终都会被路由隔离成 502，不影响已存储证据。
  return {
    result: diagnosisResultSchema.parse(JSON.parse(text)),
    model: config.modelName,
    transport: 'chat.completions',
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

async function callModel(config: ServerConfig, context: DiagnosisContext): Promise<ModelResult> {
  if (!config.modelApiKey || !config.modelApiUrl) {
    const result = diagnosisResultSchema.parse(localDiagnosis(context));
    return {
      result,
      model: 'local-evidence-engine',
      transport: 'local',
      inputTokens: Math.ceil(JSON.stringify(context).length / 4),
      outputTokens: Math.ceil(JSON.stringify(result).length / 4),
    };
  }
  const baseURL = config.modelApiUrl.replace(/\/(?:chat\/completions|responses)\/?$/, '');
  const client = new OpenAI({
    apiKey: config.modelApiKey,
    baseURL,
    timeout: 30_000,
    // SDK 层关闭自动重试，避免一次用户操作产生不可见的重复模型费用。
    maxRetries: 0,
  });

  const cacheKey = `${baseURL}|${config.modelName}`;
  if (transportCache.get(cacheKey) !== 'chat.completions') {
    try {
      const result = await viaResponses(client, config, context);
      transportCache.set(cacheKey, 'responses');
      return result;
    } catch (error) {
      // 只有"端点不支持"才降级；鉴权失败、限流、超时等仍然如实抛出。
      if (!indicatesUnsupportedEndpoint(error)) throw error;
      transportCache.set(cacheKey, 'chat.completions');
    }
  }
  return viaChatCompletions(client, config, context);
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
    Record<string, unknown> | undefined;
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
  // 缓存键包含 Prompt 版本和完整证据；任一证据变化都会自然失效。
  const inputHash = createHash('sha256')
    .update(`${PROMPT_VERSION}|${JSON.stringify(context)}`)
    .digest('hex');
  const existing = database.sqlite
    .prepare('SELECT * FROM diagnoses WHERE issue_id = ? AND input_hash = ?')
    .get(issueId, inputHash) as Record<string, unknown> | undefined;
  // force 只跳过读取缓存，数据库仍通过唯一键覆盖同一上下文，避免产生重复行。
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
