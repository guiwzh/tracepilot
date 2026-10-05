import { z } from 'zod';
import { zodFunction } from 'openai/helpers/zod';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import {
  isFailedRequest,
  redactSensitive,
  submittedReportSchema,
  type Breadcrumb,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { browserName } from '../lib/userAgent';
import { getIssue, listIssueEvents, mapEvent } from '../services/queries';
import {
  blameLine,
  commitsBetween,
  fileDiff,
  projectRepository,
  readFileAt,
  RepositoryError,
  resolveRepositoryFile,
  searchCodeAt,
} from '../services/repository';
import { lookupFor, sourceContext } from '../services/sourcemaps';

/**
 * 排障 Agent 能用的全部工具。每个工具 = 名字 + 给模型看的说明 + 参数的 Zod Schema + 执行函数。
 * 说明和参数 Schema 会转成 JSON Schema 发给模型（TOOL_SPECS），模型据此决定调用哪个、传什么参数；
 * 执行函数只在服务端运行（runTool），模型永远拿不到数据库本身。
 * MCP 服务器（mcp/server.ts）用的是同一份定义和同一个执行入口（runToolArgs），只是多一个 issueId 参数。
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
  /** 是否允许把源码片段发给模型服务商；关闭后读源码、搜代码的工具如实返回不可用。 */
  allowSourceContext: boolean;
  /** 被监控应用的 git 仓库所在的根目录（<root>/<项目 id>）；null 表示没有代码上下文。 */
  repositoryRoot: string | null;
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

export interface ToolDefinition<Parameters extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  parameters: Parameters;
  execute(args: z.infer<Parameters>, context: ToolContext): unknown;
}

// 原样返回参数的「恒等函数」，作用只在类型层面：让 TypeScript 根据 parameters 的 Schema
// 推导出 execute 的参数类型，写工具时 args 就有完整的类型提示。
function defineTool<Parameters extends z.ZodObject>(definition: ToolDefinition<Parameters>) {
  return definition;
}

/** 单个工具结果的上限。超出时截断并标记，避免一次调用吃掉整个上下文窗口。 */
export const MAX_TOOL_OUTPUT_CHARS = 6_000;

// 以下是把数据库原始值整理成「模型易读文本」的小工具：
// 毫秒时间戳 → ISO 时间字符串；数量 → 百分比；时间差 → "-3.1s"。User-Agent → 浏览器名用 lib/userAgent.ts。
function iso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

function shares(items: Array<{ name: string; value: number }>): string {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return 'no data';
  return items.map((item) => `${item.name} ${Math.round((item.value / total) * 100)}%`).join(', ');
}

function seconds(ms: number): string {
  return `${ms <= 0 ? '-' : '+'}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

/**
 * 给模型看的堆栈：最外层错误取前 12 行，每个「Caused by:」段取标题和前 3 帧。
 * 只截前 12 行的话，SDK 接在后面的 cause 链（根因往往在那里）就全被截掉了。
 */
function condenseStack(stack: string): string {
  const kept: string[] = [];
  let budget = 12;
  for (const line of stack.split('\n')) {
    if (line.startsWith('Caused by: ')) {
      kept.push(line);
      budget = 3;
    } else if (budget > 0) {
      kept.push(line);
      budget -= 1;
    }
  }
  return kept.join('\n');
}

/** 一条请求的结果：状态码；被取消的写 aborted，拿不到响应的写明是网络错误（状态码 0 本身看不出原因）。 */
function requestResult(data: Record<string, unknown>): string {
  if (data.aborted === true) return 'aborted';
  if (Number(data.status) === 0 && isFailedRequest(data)) {
    return `network error${data.error ? ` (${String(data.error)})` : ''}`;
  }
  return String(data.status ?? '?');
}

/**
 * 一条面包屑的一行描述。withTrace 时请求后面附上它在后端链路里的位置（SDK 加的 traceparent）：
 * 只给失败请求附，时间线里每行都带 48 个字符的 id 太占篇幅。
 */
function describeBreadcrumb(item: Breadcrumb, eventTime: number, withTrace = false): string {
  const offset = seconds(item.timestamp - eventTime);
  if (item.type === 'network' && item.data) {
    const duration = Number(item.data.duration);
    const business =
      item.data.businessCode === undefined
        ? ''
        : ` business error ${String(item.data.businessCode)}${item.data.businessMessage ? `: ${String(item.data.businessMessage)}` : ''}`;
    const trace =
      withTrace && typeof item.data.traceId === 'string'
        ? ` [trace ${item.data.traceId}${typeof item.data.spanId === 'string' ? ` span ${item.data.spanId}` : ''}]`
        : '';
    return `${offset} network ${String(item.data.method ?? 'GET')} ${String(item.data.url ?? item.message)} → ${requestResult(item.data)}${business}${Number.isFinite(duration) ? ` (${Math.round(duration)} ms)` : ''}${trace}`;
  }
  const count = Number(item.data?.count) > 1 ? ` (×${String(item.data?.count)})` : '';
  return `${offset} ${item.type} ${item.message}${count}`;
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
  NO_SOURCE_MAP:
    'No uploaded source map matches this file, neither by debug ID nor by release and file name.',
  FRAME_NOT_MAPPED: 'The source map has no mapping for this frame.',
  NO_SOURCES_CONTENT: 'The source map does not embed source code (sourcesContent).',
  DISABLED: 'Source snippets are disabled on this server.',
  NO_REPOSITORY:
    'No git repository is configured for this project, so its code and commit history cannot be read.',
  NO_COMMIT: 'The release has no commit recorded, so the code it shipped cannot be located.',
  COMMIT_NOT_FOUND: "The release's commit is not in the configured repository.",
  FILE_NOT_FOUND: 'That file does not exist at the release commit.',
  INVALID_PATH: 'The path must be relative to the repository root.',
  GIT_FAILED: 'The repository could not be read.',
  NO_RELEASE: 'None of the events of this issue is linked to a release.',
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
    // 规则见 shared 的 isFailedRequest：4xx 默认不成为事件但仍是证据，拿不到响应的网络错误、
    // 业务码表示失败的 2xx 也算；被取消的不算。
    const failed = event.breadcrumbs.filter(
      (item) => item.type === 'network' && isFailedRequest(item.data),
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
      stack: condenseStack(event.originalStack ?? event.stack ?? '') || null,
      stackMapped: Boolean(event.originalStack),
      timeline: event.breadcrumbs
        .slice(-15)
        .map((item) => describeBreadcrumb(item, event.createdAt)),
      failedRequests: failed.map((item) => describeBreadcrumb(item, event.createdAt, true)),
      // 这次页面浏览的 trace：后端在链路系统里按它记下了这个页面发出的请求。调查读不到链路系统。
      traceId: event.traceId ?? null,
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
    if (!event.stack) return unavailable('NO_STACK');
    const result = await sourceContext(
      context.database,
      lookupFor(context.projectId, event),
      event.stack,
      frameIndex,
    );
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
    "How this issue is spread across the project's releases, oldest first: its event count, its share of each release's errors, when it first appeared, whether source maps exist, and how many of its events still came from a release after the next one was deployed.",
  parameters: z.object({}),
  execute: (_args, context) => {
    // 每个版本一行（GROUP BY r.id）。SUM(CASE WHEN 条件 THEN 1 ELSE 0 END) 是「按条件计数」：
    // issue_events 数本 Issue 的事件，error_events 数该版本所有归入 Issue 的错误事件。
    // LEFT JOIN 让没有任何事件的版本也出现在结果里（计数为 NULL，下面按 0 处理）。
    // next_*：按部署时间的下一个版本；after_next 数本 Issue 里「下一个版本部署之后仍带着这个版本号」的事件。
    const rows = context.database.sqlite
      .prepare(
        `SELECT r.version, r.created_at,
          SUM(CASE WHEN e.issue_id = ? THEN 1 ELSE 0 END) AS issue_events,
          SUM(CASE WHEN e.issue_id IS NOT NULL THEN 1 ELSE 0 END) AS error_events,
          MIN(CASE WHEN e.issue_id = ? THEN e.created_at END) AS first_seen,
          (SELECT COUNT(*) FROM source_maps sm WHERE sm.release_id = r.id) AS source_maps,
          (SELECT n.version FROM releases n WHERE n.project_id = r.project_id AND n.created_at > r.created_at
             ORDER BY n.created_at LIMIT 1) AS next_version,
          (SELECT MIN(n.created_at) FROM releases n WHERE n.project_id = r.project_id
             AND n.created_at > r.created_at) AS next_deployed,
          SUM(CASE WHEN e.issue_id = ? AND e.created_at > (SELECT MIN(n.created_at) FROM releases n
             WHERE n.project_id = r.project_id AND n.created_at > r.created_at) THEN 1 ELSE 0 END) AS after_next
         FROM releases r LEFT JOIN events e ON e.release_id = r.id
         WHERE r.project_id = ? GROUP BY r.id ORDER BY r.created_at ASC`,
      )
      .all(context.issueId, context.issueId, context.issueId, context.projectId) as Array<{
      version: string;
      created_at: number;
      issue_events: number | null;
      error_events: number | null;
      first_seen: number | null;
      source_maps: number;
      next_version: string | null;
      next_deployed: number | null;
      after_next: number | null;
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
        // 事件带的版本号是页面加载时的版本：下一个版本部署之后还在上报这个版本的，是部署之前加载、没有刷新的页面。
        ...(row.next_version
          ? {
              eventsAfterNextRelease: {
                nextRelease: row.next_version,
                nextDeployedAt: iso(row.next_deployed),
                issueEvents: Number(row.after_next ?? 0),
              },
            }
          : {}),
      };
    });
    const affected = releases.filter((release) => release.issueEvents > 0);
    const total = affected.reduce((sum, release) => sum + release.issueEvents, 0);
    const first = [...affected].sort((left, right) =>
      String(left.firstSeenInRelease).localeCompare(String(right.firstSeenInRelease)),
    )[0];
    // 部署时间与页面加载的先后直接写成一句话：真实模型评测里，模型三次中有两次没注意到报错页面加载于部署之前。
    const stale = affected
      .filter((release) => (release.eventsAfterNextRelease?.issueEvents ?? 0) > 0)
      .map(
        (release) =>
          ` ${release.eventsAfterNextRelease!.issueEvents} of ${release.issueEvents} events of ${release.version} happened after ${release.eventsAfterNextRelease!.nextRelease} was deployed (${release.eventsAfterNextRelease!.nextDeployedAt}): they come from pages loaded before that deployment and still running ${release.version}.`,
      )
      .join('');
    const summary =
      affected.length === 0
        ? 'The issue has no events linked to a release.'
        : `The issue appears in ${affected.length} of ${releases.length} releases and was first seen in ${first!.version}; ${affected
            .map(
              (release) =>
                `${release.version} has ${Math.round((release.issueEvents / total) * 100)}% of its events`,
            )
            .join(', ')}.${stale}`;
    return { summary, releases };
  },
});

interface ReleaseRow {
  version: string;
  commit_sha: string | null;
  created_at: number;
  issue_events: number;
  first_seen: number | null;
}

/** 项目的全部版本（按部署时间），以及本 Issue 在每个版本里的事件数和首次出现时间。 */
function releasesOf(context: ToolContext): ReleaseRow[] {
  return context.database.sqlite
    .prepare(
      `SELECT r.version, r.commit_sha, r.created_at,
         SUM(CASE WHEN e.issue_id = ? THEN 1 ELSE 0 END) AS issue_events,
         MIN(CASE WHEN e.issue_id = ? THEN e.created_at END) AS first_seen
       FROM releases r LEFT JOIN events e ON e.release_id = r.id
       WHERE r.project_id = ? GROUP BY r.id ORDER BY r.created_at`,
    )
    .all(context.issueId, context.issueId, context.projectId) as ReleaseRow[];
}

/**
 * 代码类工具读哪个版本：参数指定的版本，否则是本 Issue 最近一个事件所在的版本（出错的就是那份代码）。
 */
function targetRelease(context: ToolContext, version: string | undefined): ReleaseRow {
  const releases = releasesOf(context);
  if (version) {
    const named = releases.find((release) => release.version === version);
    if (!named) {
      throw new ToolError('RELEASE_NOT_FOUND', `This project has no release "${version}".`);
    }
    return named;
  }
  const latest = context.database.sqlite
    .prepare(
      `SELECT r.version FROM events e JOIN releases r ON r.id = e.release_id
       WHERE e.issue_id = ? ORDER BY e.created_at DESC LIMIT 1`,
    )
    .get(context.issueId) as { version: string } | undefined;
  const release = latest && releases.find((item) => item.version === latest.version);
  if (!release) throw new RepositoryError('NO_COMMIT', 'NO_RELEASE');
  return release;
}

/** 代码类工具拿不到结果时的统一回答：原因码加说明，模型把它记进 missingInformation。 */
function codeUnavailable(reason: string, release?: string) {
  return { available: false, reason, meaning: SOURCE_UNAVAILABLE[reason] ?? reason, release };
}

/** 运行一个代码类工具：仓库缺失、提交缺失等预期内的情况变成 codeUnavailable，其余错误照常抛出。 */
async function withRepository<T>(
  context: ToolContext,
  run: (repository: string) => Promise<T>,
): Promise<T | ReturnType<typeof codeUnavailable>> {
  const repository = projectRepository(context.repositoryRoot, context.projectId);
  if (!repository) return codeUnavailable('NO_REPOSITORY');
  try {
    return await run(repository);
  } catch (error) {
    if (error instanceof RepositoryError) {
      return codeUnavailable(error.message === 'NO_RELEASE' ? 'NO_RELEASE' : error.code);
    }
    throw error;
  }
}

const readSourceFile = defineTool({
  name: 'read_source_file',
  description:
    "Lines of a file from the application's git repository, exactly as shipped in a release (default: the release of the issue's latest event). Use it to read more than get_source_context shows, or files the stack does not reach. At most 80 lines per call.",
  parameters: z.object({
    path: z
      .string()
      .min(1)
      .max(300)
      .describe('Path relative to the repository root, e.g. src/checkout/total.ts'),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    release: z
      .string()
      .min(1)
      .max(120)
      .nullable()
      .optional()
      .describe('Release version; defaults to the latest one with this issue'),
  }),
  execute: async ({ path, startLine, endLine, release: version }, context) => {
    if (!context.allowSourceContext) return codeUnavailable('DISABLED');
    const release = targetRelease(context, version ?? undefined);
    return withRepository(context, async (repository) => {
      const file = await readFileAt(
        repository,
        release.commit_sha,
        path,
        startLine,
        Math.min(Math.max(endLine, startLine), startLine + 79),
      );
      return {
        available: true,
        release: release.version,
        commit: file.commit.slice(0, 12),
        path: file.path,
        totalLines: file.totalLines,
        // 带行号的文本：模型引用时连行号一起摘，读的人也能对上编辑器里的位置。
        code: file.lines
          .map((text, offset) => `${String(file.startLine + offset).padStart(4)} | ${text}`)
          .join('\n'),
      };
    });
  },
});

const searchCode = defineTool({
  name: 'search_code',
  description:
    "Literal (not regex) text search over the application's git repository as shipped in a release: where a field is defined, who else calls a function, how a value is produced. Returns at most 20 matching lines.",
  parameters: z.object({
    query: z.string().min(2).max(100),
    path: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe('Only search under this directory or file'),
    release: z.string().min(1).max(120).nullable().optional(),
  }),
  execute: async ({ query, path, release: version }, context) => {
    if (!context.allowSourceContext) return codeUnavailable('DISABLED');
    const release = targetRelease(context, version ?? undefined);
    return withRepository(context, async (repository) => {
      const result = await searchCodeAt(
        repository,
        release.commit_sha,
        query,
        path ?? undefined,
        20,
      );
      return {
        available: true,
        release: release.version,
        commit: result.commit.slice(0, 12),
        matches: result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`),
        truncated: result.truncated,
      };
    });
  },
});

/** 还原后堆栈里的一帧：at fn (src/x.ts:12:5)。只取映射到源码的帧，跳过依赖包和仍是压缩地址的帧。 */
const MAPPED_FRAME = /at\s+\S+\s+\(([^()\s]+):(\d+):\d+\)/;

function inAppFrames(originalStack: string): Array<{ source: string; line: number }> {
  const frames: Array<{ source: string; line: number }> = [];
  for (const text of originalStack.split('\n')) {
    const match = MAPPED_FRAME.exec(text);
    if (!match) continue;
    const source = match[1]!;
    if (/^[a-z]+:\/\//i.test(source) || source.includes('node_modules/')) continue;
    frames.push({ source, line: Number(match[2]) });
  }
  return frames;
}

const findSuspectCommits = defineTool({
  name: 'find_suspect_commits',
  description:
    'Which code change likely introduced this issue: the release it first appeared in, the commits between the previous release and that one (flagging those that touch files in the stack), and the commit that last changed the failing line (git blame).',
  parameters: z.object({}),
  execute: async (_args, context) => {
    const releases = releasesOf(context);
    const affected = releases.filter((release) => release.issue_events > 0);
    const first = affected[0];
    if (!first) return codeUnavailable('NO_RELEASE');
    const previous = releases
      .filter((release) => release.created_at < first.created_at && release.commit_sha)
      .at(-1);
    return withRepository(context, async (repository) => {
      // 最近一个已还原的事件的应用帧，对到仓库里的文件。
      const sample = context.database.sqlite
        .prepare(
          `SELECT original_stack FROM events WHERE issue_id = ? AND original_stack IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(context.issueId) as { original_stack: string } | undefined;
      const stackFiles: Array<{ path: string; line: number }> = [];
      for (const frame of inAppFrames(sample?.original_stack ?? '').slice(0, 5)) {
        const path = await resolveRepositoryFile(
          repository,
          first.commit_sha ?? '',
          frame.source,
        ).catch(() => null);
        if (path && !stackFiles.some((file) => file.path === path))
          stackFiles.push({ path, line: frame.line });
      }

      const top = stackFiles[0];
      const blame = top ? await blameLine(repository, first.commit_sha, top.path, top.line) : null;
      const commits = previous
        ? await commitsBetween(repository, previous.commit_sha, first.commit_sha, 30)
        : [];
      const stackPaths = new Set(stackFiles.map((file) => file.path));
      const inRange = commits.map((commit) => ({
        commit: commit.sha.slice(0, 12),
        author: commit.author,
        date: commit.date,
        subject: commit.subject,
        files: commit.files.slice(0, 10),
        touchesStackFiles: commit.files.filter((file) => stackPaths.has(file)),
      }));
      const suspects = inRange.filter((commit) => commit.touchesStackFiles.length > 0);
      const blameInRange = Boolean(blame && commits.some((commit) => commit.sha === blame.sha));

      const summary = !previous
        ? `${first.version} is the first release with a recorded commit, so there is no earlier release to compare with.`
        : `${suspects.length} of ${inRange.length} commits between ${previous.version} and ${first.version} touched files in the stack${
            suspects[0]
              ? `; ${suspects[0].commit.slice(0, 7)} "${suspects[0].subject}" by ${suspects[0].author} changed ${suspects[0].touchesStackFiles.join(', ')}`
              : ''
          }.`;
      return {
        available: true,
        firstSeenRelease: first.version,
        previousRelease: previous?.version ?? null,
        range: previous
          ? `${String(previous.commit_sha).slice(0, 12)}..${String(first.commit_sha).slice(0, 12)}`
          : null,
        stackFiles: stackFiles.map((file) => `${file.path}:${file.line}`),
        summary,
        lastChangeToFailingLine: blame
          ? {
              commit: blame.sha.slice(0, 12),
              author: blame.author,
              date: blame.date,
              subject: blame.subject,
              line: `${blame.files[0]}:${blame.line}`,
              // 出错那一行的代码只在允许外发源码时给出。
              ...(context.allowSourceContext ? { code: blame.code } : {}),
              inReleaseRange: blameInRange,
            }
          : null,
        commitsInRange: inRange.slice(0, 10),
        // 嫌疑提交对出错文件的改动：只在允许外发源码时给出，最多 30 行。
        diff:
          context.allowSourceContext && blameInRange && blame && top
            ? await fileDiff(repository, blame.sha, top.path, 30)
            : null,
      };
    });
  },
});

/**
 * 收集证据用的 8 个只读工具。参数都是 z.object：MCP 在它们之上扩展出 issueId。
 * 后三个读被监控应用的 git 仓库（services/repository.ts）。项目没有仓库时不交给排障 Agent（toolSpecsFor）；
 * MCP 照常列出，调用时如实回答「没有配置仓库」。
 */
export const INVESTIGATION_TOOLS: ToolDefinition[] = [
  getIssueOverview,
  listEventSamples,
  getEventDetail,
  getSourceContext,
  compareReleases,
  readSourceFile,
  searchCode,
  findSuspectCommits,
];

/**
 * 第 9 个工具 submit_report 没有执行函数：模型「调用」它就是提交最终报告，
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

/** 发给模型的工具清单（OpenAI tools 格式）：8 个取证工具 + submit_report。 */
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

/** 读被监控应用 git 仓库的三个工具。 */
export const CODE_TOOLS: readonly string[] = [
  'read_source_file',
  'search_code',
  'find_suspect_commits',
];

/**
 * 这次调查交给模型的工具。项目没有配置仓库时去掉三个代码类工具：它们只会回答「没有配置仓库」，
 * 提示词 v4 的真实模型评测里（那时还交给模型），Agent 平均每次调查仍会调用它们约 3 次，白白多出几轮对话的 token。
 */
export function toolSpecsFor(context: Pick<ToolContext, 'repositoryRoot' | 'projectId'>) {
  return projectRepository(context.repositoryRoot, context.projectId)
    ? TOOL_SPECS
    : TOOL_SPECS.filter((tool) => !CODE_TOOLS.includes(tool.function.name));
}

export interface ToolResult {
  ok: boolean;
  /** 发给模型的结果正文（JSON 字符串）。失败时形如 {"error":"…","message":"…"}。 */
  output: string;
  /** 结果超过 MAX_TOOL_OUTPUT_CHARS 被截断时为 true。 */
  truncated: boolean;
}

function toolFailure(code: string, message: string): ToolResult {
  return { ok: false, output: JSON.stringify({ error: code, message }), truncated: false };
}

/** 执行一次工具调用：解析参数、校验、执行、脱敏、截断。任何失败都变成给模型看的错误结果，不抛出。 */
export async function runTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<ToolResult> {
  let args: unknown;
  try {
    args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return toolFailure('INVALID_ARGUMENTS', 'Tool arguments must be a JSON object.');
  }
  return runToolArgs(name, args, context);
}

/**
 * 参数已经是对象时的执行入口（MCP 客户端传来的就是对象）：校验、执行、脱敏、截断。
 * Agent 和 MCP 走同一条路：同样的校验、同样在结果离开服务端之前再脱敏一次、同样的长度上限。
 */
export async function runToolArgs(
  name: string,
  args: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = INVESTIGATION_TOOLS.find((candidate) => candidate.name === name);
  const failure = toolFailure;
  if (!tool) return failure('UNKNOWN_TOOL', `There is no tool named "${name}".`);
  const parsed = tool.parameters.safeParse(args);
  if (!parsed.success) {
    return failure(
      'INVALID_ARGUMENTS',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; '),
    );
  }

  try {
    const value = await tool.execute(parsed.data, context);
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
