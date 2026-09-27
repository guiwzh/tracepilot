import { z } from 'zod';
import { zodFunction } from 'openai/helpers/zod';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { redactSensitive, submittedReportSchema, type Breadcrumb } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { getIssue, listIssueEvents, mapEvent } from '../services/queries';
import { sourceContext } from '../services/sourcemaps';

/**
 * 排障 Agent 能用的全部工具。每个工具 = 名字 + 给模型看的说明 + 参数的 Zod Schema + 执行函数。
 * 说明和参数 Schema 会转成 JSON Schema 发给模型（TOOL_SPECS），模型据此决定调用哪个、传什么参数；
 * 执行函数只在服务端运行（runTool），模型永远拿不到数据库本身。
 *
 * 设计上的三条约束：
 *
 * 1. 只读。没有任何工具能改数据、改代码或访问外部系统，模型被注入了也造不成写操作。
 * 2. 作用域绑定。工具只能看到本次调查的 Issue 及其所在项目；参数里的 eventId 也会校验归属，
 *    模型无法借工具读取别的项目。
 * 3. 输出可引用。关键事实用可读的句子表达（例如 "-3.1s network POST … → 503"），
 *    模型提交报告时要从这里逐字摘出原文，服务端再核对原文确实存在。
 */

/** 工具执行时的上下文：由服务端在调查开始时确定，模型无法修改。 */
export interface ToolContext {
  database: TraceDatabase;
  issueId: string;
  projectId: string;
  /** 是否允许把源码片段发给模型服务商；关闭后 get_source_context 如实返回不可用。 */
  allowSourceContext: boolean;
}

/** 工具里预期内的失败（例如事件不存在）。code 和 message 会原样回给模型，让它换个参数重试。 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ToolDefinition<Parameters extends z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: Parameters;
  execute(args: z.infer<Parameters>, context: ToolContext): unknown;
}

// 原样返回参数的「恒等函数」，作用只在类型层面：让 TypeScript 根据 parameters 的 Schema
// 推导出 execute 的参数类型，写工具时 args 就有完整的类型提示。
function defineTool<Parameters extends z.ZodTypeAny>(definition: ToolDefinition<Parameters>) {
  return definition;
}

/** 单个工具结果的上限。超出时截断并标记，避免一次调用吃掉整个上下文窗口。 */
export const MAX_TOOL_OUTPUT_CHARS = 6_000;

// 以下是把数据库原始值整理成「模型易读文本」的小工具：
// 毫秒时间戳 → ISO 时间字符串；User-Agent → 浏览器名；数量 → 百分比；时间差 → "-3.1s"。
function iso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

function browserName(userAgent: string): string {
  if (userAgent.includes('Edg/')) return 'Edge';
  if (userAgent.includes('Chrome/')) return 'Chrome';
  if (userAgent.includes('Firefox/')) return 'Firefox';
  if (userAgent.includes('Safari/')) return 'Safari';
  return 'Other';
}

function shares(items: Array<{ name: string; value: number }>): string {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return 'no data';
  return items.map((item) => `${item.name} ${Math.round((item.value / total) * 100)}%`).join(', ');
}

function seconds(ms: number): string {
  return `${ms <= 0 ? '-' : '+'}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

function describeBreadcrumb(item: Breadcrumb, eventTime: number): string {
  const offset = seconds(item.timestamp - eventTime);
  if (item.type === 'network' && item.data) {
    const duration = Number(item.data.duration);
    return `${offset} network ${String(item.data.method ?? 'GET')} ${String(item.data.url ?? item.message)} → ${String(item.data.status ?? '?')}${Number.isFinite(duration) ? ` (${Math.round(duration)} ms)` : ''}`;
  }
  return `${offset} ${item.type} ${item.message}`;
}

/** 按 id 取事件，并用 issue_id 条件保证它属于本次调查的 Issue（作用域绑定）。 */
function findEvent(context: ToolContext, eventId: string) {
  const row = context.database.sqlite
    .prepare('SELECT * FROM events WHERE id = ? AND issue_id = ?')
    .get(eventId, context.issueId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new ToolError(
      'EVENT_NOT_FOUND',
      `No event "${eventId}" belongs to this issue. Use list_event_samples to get valid ids.`,
    );
  }
  return mapEvent(row);
}

/** 拿不到源码时的原因说明，让模型把它写进 missingInformation，而不是自己猜测源码。 */
const SOURCE_UNAVAILABLE: Record<string, string> = {
  NO_STACK: 'This event has no stack trace.',
  NO_FRAME: 'The stack has no frame at that index.',
  NO_SOURCE_MAP: 'No source map was uploaded for this file in this release.',
  FRAME_NOT_MAPPED: 'The source map has no mapping for this frame.',
  NO_SOURCES_CONTENT: 'The source map does not embed source code (sourcesContent).',
  DISABLED: 'Source snippets are disabled on this server.',
};

const getIssueOverview = defineTool({
  name: 'get_issue_overview',
  description:
    'Summary of the issue under investigation: title, counts, first/last seen, and how its events split across browsers, routes and releases.',
  parameters: z.object({}),
  execute: (_args, context) => {
    const issue = getIssue(context.database, context.issueId);
    if (!issue) throw new ToolError('ISSUE_NOT_FOUND', 'The issue no longer exists.');
    return {
      issue: {
        title: issue.title,
        level: issue.level,
        status: issue.status,
        events: issue.eventCount,
        affectedUsers: issue.userCount,
        firstSeen: iso(issue.firstSeenAt),
        lastSeen: iso(issue.lastSeenAt),
        latestRelease: issue.latestRelease,
      },
      distribution: {
        browsers: shares(issue.browserDistribution),
        routes: shares(issue.routeDistribution),
        releases: shares(issue.releaseDistribution),
      },
    };
  },
});

const listEventSamples = defineTool({
  name: 'list_event_samples',
  description: 'The most recent events of this issue, newest first, with ids for get_event_detail.',
  parameters: z.object({ limit: z.number().int().min(1).max(10) }),
  execute: ({ limit }, context) => ({
    samples: listIssueEvents(context.database, context.issueId, limit).map((event) => ({
      eventId: event.id,
      capturedAt: iso(event.createdAt),
      release: event.context.release,
      page: event.pageUrl,
      browser: browserName(event.context.device.userAgent),
      message: event.message,
      stackMapped: Boolean(event.originalStack),
      breadcrumbs: event.breadcrumbs.length,
    })),
  }),
});

const getEventDetail = defineTool({
  name: 'get_event_detail',
  description:
    'One event in full: error message, stack (source-mapped when possible), and a timeline of the user actions and requests that preceded it, relative to the error.',
  parameters: z.object({ eventId: z.string().min(1).max(200) }),
  execute: ({ eventId }, context) => {
    const event = findEvent(context, eventId);
    const payload = event.context.payload;
    const failed = event.breadcrumbs.filter(
      (item) => item.type === 'network' && Number(item.data?.status ?? 0) >= 400,
    );
    return {
      eventId: event.id,
      capturedAt: iso(event.createdAt),
      release: event.context.release,
      page: event.pageUrl,
      browser: browserName(event.context.device.userAgent),
      userAgent: event.context.device.userAgent,
      // 不叫 error：工具失败时的结果形如 { error, message }，同名字段会让两者难以区分。
      message: event.message,
      stack: (event.originalStack ?? event.stack ?? '').split('\n').slice(0, 12).join('\n') || null,
      stackMapped: Boolean(event.originalStack),
      timeline: event.breadcrumbs
        .slice(-15)
        .map((item) => describeBreadcrumb(item, event.createdAt)),
      failedRequests: failed.map((item) => describeBreadcrumb(item, event.createdAt)),
      // SDK 在事件超限时会裁剪证据，调查要知道自己看到的并不完整。
      captureNotes: [
        payload.trimmedBreadcrumbs
          ? `${String(payload.trimmedBreadcrumbs)} older breadcrumbs were trimmed by the SDK`
          : null,
        payload.truncated ? 'long payload fields were truncated by the SDK' : null,
      ].filter(Boolean),
    };
  },
});

const getSourceContext = defineTool({
  name: 'get_source_context',
  description:
    'Original source code around one stack frame of an event (frameIndex 0 is the top frame), resolved through the release source map. Reports why when unavailable.',
  parameters: z.object({
    eventId: z.string().min(1).max(200),
    frameIndex: z.number().int().min(0).max(9),
  }),
  execute: async ({ eventId, frameIndex }, context) => {
    const event = findEvent(context, eventId);
    const unavailable = (reason: string) => ({
      available: false,
      reason,
      meaning: SOURCE_UNAVAILABLE[reason] ?? reason,
      release: event.context.release,
    });
    if (!context.allowSourceContext) return unavailable('DISABLED');
    if (!event.stack || !event.releaseId) return unavailable('NO_STACK');
    const result = await sourceContext(context.database, event.releaseId, event.stack, frameIndex);
    if (!result.ok) return unavailable(result.reason);
    return {
      available: true,
      // 键名刻意不用 location：脱敏会把 url/location 这类键的值当成 URL 处理，路径会被改写。
      frame: result.location,
      function: result.functionName,
      snippet: result.snippet,
    };
  },
});

const compareReleases = defineTool({
  name: 'compare_releases',
  description:
    "How this issue is spread across the project's releases, oldest first: its event count, its share of each release's errors, when it first appeared, and whether source maps exist.",
  parameters: z.object({}),
  execute: (_args, context) => {
    // 每个版本一行（GROUP BY r.id）。SUM(CASE WHEN 条件 THEN 1 ELSE 0 END) 是「按条件计数」：
    // issue_events 数本 Issue 的事件，error_events 数该版本所有归入 Issue 的错误事件。
    // LEFT JOIN 让没有任何事件的版本也出现在结果里（计数为 NULL，下面按 0 处理）。
    const rows = context.database.sqlite
      .prepare(
        `SELECT r.version, r.created_at,
          SUM(CASE WHEN e.issue_id = ? THEN 1 ELSE 0 END) AS issue_events,
          SUM(CASE WHEN e.issue_id IS NOT NULL THEN 1 ELSE 0 END) AS error_events,
          MIN(CASE WHEN e.issue_id = ? THEN e.created_at END) AS first_seen,
          (SELECT COUNT(*) FROM source_maps sm WHERE sm.release_id = r.id) AS source_maps
         FROM releases r LEFT JOIN events e ON e.release_id = r.id
         WHERE r.project_id = ? GROUP BY r.id ORDER BY r.created_at ASC`,
      )
      .all(context.issueId, context.issueId, context.projectId) as Array<{
      version: string;
      created_at: number;
      issue_events: number | null;
      error_events: number | null;
      first_seen: number | null;
      source_maps: number;
    }>;
    const releases = rows.map((row) => {
      const issueEvents = Number(row.issue_events ?? 0);
      const errorEvents = Number(row.error_events ?? 0);
      return {
        version: row.version,
        deployedAt: iso(row.created_at),
        issueEvents,
        shareOfReleaseErrors: errorEvents
          ? `${Math.round((issueEvents / errorEvents) * 100)}%`
          : 'n/a',
        firstSeenInRelease: iso(row.first_seen),
        sourceMaps: row.source_maps,
      };
    });
    const affected = releases.filter((release) => release.issueEvents > 0);
    const total = affected.reduce((sum, release) => sum + release.issueEvents, 0);
    const first = [...affected].sort((left, right) =>
      String(left.firstSeenInRelease).localeCompare(String(right.firstSeenInRelease)),
    )[0];
    const summary =
      affected.length === 0
        ? 'The issue has no events linked to a release.'
        : `The issue appears in ${affected.length} of ${releases.length} releases and was first seen in ${first!.version}; ${affected
            .map(
              (release) =>
                `${release.version} has ${Math.round((release.issueEvents / total) * 100)}% of its events`,
            )
            .join(', ')}.`;
    return { summary, releases };
  },
});

/** 收集证据用的 5 个只读工具。 */
export const INVESTIGATION_TOOLS = [
  getIssueOverview,
  listEventSamples,
  getEventDetail,
  getSourceContext,
  compareReleases,
];

/**
 * 第 6 个工具 submit_report 没有执行函数：模型「调用」它就是提交最终报告，
 * 参数就是报告内容。用工具参数而不是自由文本交报告，服务端才能按 Schema 校验。
 */
export const SUBMIT_REPORT_TOOL = 'submit_report';

function toOpenAITool(
  name: string,
  description: string,
  parameters: z.ZodTypeAny,
): ChatCompletionFunctionTool {
  // JSON Schema 由同一份 Zod 定义生成，工具说明书与服务端校验不会漂移。
  // 关闭 strict：国产 OpenAI 兼容端点对严格模式支持不一，形状最终由服务端 Zod 兜底。
  const tool = zodFunction({ name, description, parameters });
  return {
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false,
    },
  };
}

/** 发给模型的工具清单（OpenAI tools 格式）：5 个取证工具 + submit_report。 */
export const TOOL_SPECS: ChatCompletionFunctionTool[] = [
  ...INVESTIGATION_TOOLS.map((tool) => toOpenAITool(tool.name, tool.description, tool.parameters)),
  toOpenAITool(
    SUBMIT_REPORT_TOOL,
    'Finish the investigation. Every evidence item sets resultRef to the ref printed on the first line of a tool result (such as T3) and quotes text copied verbatim from that result; every cause lists the indexes of the evidence that supports it.',
    submittedReportSchema,
  ),
];

/** 收尾阶段只提供 submit_report。 */
export const SUBMIT_ONLY_TOOL_SPECS = TOOL_SPECS.filter(
  (tool) => tool.function.name === SUBMIT_REPORT_TOOL,
);

export interface ToolResult {
  ok: boolean;
  /** 发给模型的结果正文（JSON 字符串）。失败时形如 {"error":"…","message":"…"}。 */
  output: string;
  /** 结果超过 MAX_TOOL_OUTPUT_CHARS 被截断时为 true。 */
  truncated: boolean;
}

/** 执行一次工具调用：解析参数、校验、执行、脱敏、截断。任何失败都变成给模型看的错误结果，不抛出。 */
export async function runTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = INVESTIGATION_TOOLS.find((candidate) => candidate.name === name);
  const failure = (code: string, message: string): ToolResult => ({
    ok: false,
    output: JSON.stringify({ error: code, message }),
    truncated: false,
  });
  if (!tool) return failure('UNKNOWN_TOOL', `There is no tool named "${name}".`);

  let args: unknown;
  try {
    args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return failure('INVALID_ARGUMENTS', 'Tool arguments must be a JSON object.');
  }
  const parsed = (tool.parameters as z.ZodTypeAny).safeParse(args);
  if (!parsed.success) {
    return failure(
      'INVALID_ARGUMENTS',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; '),
    );
  }

  try {
    const value = await (tool.execute as (args: unknown, context: ToolContext) => unknown)(
      parsed.data,
      context,
    );
    // 入库时已经脱敏过一次；这里是发给模型前的最后一道防线，防止历史脏数据流出。
    const output = JSON.stringify(redactSensitive(value));
    if (output.length <= MAX_TOOL_OUTPUT_CHARS) return { ok: true, output, truncated: false };
    return {
      ok: true,
      output: `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[truncated]`,
      truncated: true,
    };
  } catch (error) {
    if (error instanceof ToolError) return failure(error.code, error.message);
    return failure('TOOL_FAILED', 'The tool failed unexpectedly.');
  }
}
