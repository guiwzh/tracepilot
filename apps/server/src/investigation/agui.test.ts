import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventSchema } from '@ag-ui/core/schemas';
import { HttpAgent, type BaseEvent } from '@ag-ui/client';
import type {
  InvestigationEvent,
  InvestigationReport,
  InvestigationStreamEvent,
} from '@trace-pilot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { ServerConfig } from '../config';
import { createDatabase } from '../db/client';
import { seedDemoData } from '../seed';
import { AgUiEncoder, parseAgUiCursor } from './agui';

const usage = { inputTokens: 1200, outputTokens: 300, steps: 3, toolCalls: 2 };

const report: InvestigationReport = {
  summary: 'calculateTotal reads cart.summary.total while summary is missing.',
  evidence: [
    {
      resultRef: 'T2',
      toolCallId: 'call-2',
      quote: 'summary?: CartSummary;',
      description: 'The type allows a missing summary.',
      source: 'source',
      verified: true,
    },
  ],
  possibleCauses: [{ cause: 'summary is optional.', confidence: 0.8, evidenceRefs: [0] }],
  investigationSteps: [],
  suggestions: [],
  missingInformation: [],
  verification: { attempts: 2, allVerified: true, problems: [] },
  disclaimer: 'd',
};

/** 一次调查的事件日志：两轮工具调用、一次被驳回的报告、最后完成。 */
function log(ending: InvestigationEvent): InvestigationStreamEvent[] {
  const events: InvestigationEvent[] = [
    { type: 'run.started', engine: 'model', model: 'deepseek-chat' },
    { type: 'step.started', step: 1 },
    { type: 'text.delta', step: 1, text: 'Start with the ' },
    { type: 'text.delta', step: 1, text: 'issue overview.' },
    {
      type: 'tool.called',
      step: 1,
      toolCallId: 'call-1',
      ref: 'T1',
      name: 'get_issue_overview',
      args: {},
    },
    {
      type: 'tool.completed',
      step: 1,
      toolCallId: 'call-1',
      ok: true,
      output: 'ref: T1 (get_issue_overview)\n{"title":"Cannot read properties of undefined"}',
      truncated: false,
      durationMs: 3,
    },
    { type: 'step.started', step: 2 },
    // 这一轮没有旁白，直接调工具。
    {
      type: 'tool.called',
      step: 2,
      toolCallId: 'call-2',
      ref: 'T2',
      name: 'read_source_file',
      args: { path: 'src/api/types.ts', startLine: 1, endLine: 20 },
    },
    {
      type: 'tool.completed',
      step: 2,
      toolCallId: 'call-2',
      ok: true,
      output: 'ref: T2 (read_source_file)\n{"code":"summary?: CartSummary;"}',
      truncated: false,
      durationMs: 5,
    },
    { type: 'step.started', step: 3 },
    { type: 'report.rejected', step: 3, problems: ['evidence[0]: quote not found in T9'] },
    { type: 'text.delta', step: 3, text: 'Corrected the citation.' },
    ending,
  ];
  return events.map((event, index) => ({ seq: index + 1, at: 1_770_000_000_000 + index, event }));
}

function encodeAll(records: InvestigationStreamEvent[]) {
  const encoder = new AgUiEncoder('run-1', 'issue-1');
  return records.flatMap((record) => encoder.encode(record));
}

/** 把事件写成 AG-UI 的 SSE，交给官方客户端解析。 */
function sseResponse(events: BaseEvent[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AG-UI projection of the event log', () => {
  it('produces events the official schemas accept and the official client can apply', async () => {
    const encoded = encodeAll(log({ type: 'run.completed', report, usage }));
    for (const { event } of encoded) expect(EventSchema.safeParse(event).success).toBe(true);
    expect(encoded.map(({ event }) => event.type)).toEqual([
      'RUN_STARTED',
      'STATE_SNAPSHOT',
      'STEP_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'STEP_FINISHED',
      'STEP_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'STEP_FINISHED',
      'STEP_STARTED',
      'STATE_DELTA',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      'STATE_DELTA',
      'RUN_FINISHED',
    ]);
    // 每条记录的事件按「seq.序号」编号，续传靠它。
    expect(encoded.slice(0, 3).map(({ id }) => id)).toEqual(['1.0', '1.1', '2.0']);

    // 官方客户端：校验事件顺序（例如结束前消息、工具调用、轮次都要收尾），再应用成消息和状态。
    const agent = new HttpAgent({
      url: 'http://agui.test/',
      threadId: 'issue-1',
      fetch: async () => sseResponse(encoded.map(({ event }) => event)),
    });
    const { result } = await agent.runAgent();
    expect(result).toMatchObject({ summary: report.summary });
    expect(agent.state).toMatchObject({
      status: 'completed',
      engine: 'model',
      rejections: [{ step: 3, problems: ['evidence[0]: quote not found in T9'] }],
      report: { verification: { allVerified: true } },
      usage,
    });
    const assistant = agent.messages.filter((message) => message.role === 'assistant');
    expect(assistant.map((message) => message.content ?? '')).toContain(
      'Start with the issue overview.',
    );
    // 第一轮的工具调用挂在那段旁白下面；第二轮没有旁白，客户端自己建一条消息装它。
    const calls = assistant.flatMap((message) =>
      'toolCalls' in message ? (message.toolCalls ?? []) : [],
    );
    expect(calls.map((call) => [call.function.name, call.function.arguments])).toEqual([
      ['get_issue_overview', '{}'],
      ['read_source_file', '{"path":"src/api/types.ts","startLine":1,"endLine":20}'],
    ]);
    const tool = agent.messages.find((message) => message.role === 'tool');
    expect(tool).toMatchObject({
      toolCallId: 'call-1',
      content: expect.stringContaining('ref: T1'),
    });
  });

  it('ends a cancelled run with a cancelled outcome and a failed one with RUN_ERROR', () => {
    const cancelled = encodeAll(log({ type: 'run.cancelled', usage })).map(({ event }) => event);
    const failed = encodeAll(
      log({ type: 'run.failed', error: 'STEP_LIMIT', message: 'Step limit reached.', usage }),
    ).map(({ event }) => event);
    for (const event of [...cancelled, ...failed]) {
      expect(EventSchema.safeParse(event).success).toBe(true);
    }
    expect(cancelled.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: { type: 'cancelled' },
      usage: [{ model: 'deepseek-chat', inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }],
    });
    expect(failed.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      code: 'STEP_LIMIT',
      message: 'Step limit reached.',
    });
    // 结束之前，开着的消息和轮次先收尾。
    expect(failed.slice(-4).map((event) => event.type)).toEqual([
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      'STATE_DELTA',
      'RUN_ERROR',
    ]);
  });

  it('reads resume positions from either a full id or a plain sequence number', () => {
    expect(parseAgUiCursor('12.3')).toEqual({ seq: 12, index: 3 });
    expect(parseAgUiCursor('12')).toEqual({ seq: 12, index: Number.POSITIVE_INFINITY });
    expect(parseAgUiCursor(undefined)).toEqual({ seq: 0, index: Number.POSITIVE_INFINITY });
    expect(parseAgUiCursor('not-an-id')).toEqual({ seq: 0, index: Number.POSITIVE_INFINITY });
  });
});

describe('AG-UI endpoints', () => {
  let directory: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let issueId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tracepilot-agui-'));
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      databasePath: join(directory, 'test.db'),
      sourceMapDir: join(directory, 'maps'),
      modelName: 'test-model',
      localAgentStepDelayMs: 0,
      agentSourceContext: true,
      ingestRateLimitPerMinute: 6_000,
      spikeProtection: true,
      repositoryRoot: join(directory, 'repos'),
      dashboardUrl: 'http://localhost:4173',
      autoInvestigationsPerDay: 10,
    };
    const database = createDatabase(config.databasePath);
    await seedDemoData(database, config.sourceMapDir, config.repositoryRoot);
    database.close();
    app = await buildApp({ config, logger: false });
    base = await app.listen({ port: 0, host: '127.0.0.1' });
    const issues = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/demo-project/issues?search=${encodeURIComponent("reading 'total'")}`,
    });
    issueId = (issues.json() as { items: Array<{ id: string }> }).items[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  /** 读完一个 SSE 响应，取出每条消息的 id 和事件。 */
  async function readStream(response: Response) {
    const text = await response.text();
    return text
      .split('\n\n')
      .map((block) => ({
        id: /^id: (.*)$/m.exec(block)?.[1],
        data: /^data: (.*)$/m.exec(block)?.[1],
      }))
      .filter((item): item is { id: string; data: string } => Boolean(item.id && item.data))
      .map(({ id, data }) => ({ id, event: JSON.parse(data) as BaseEvent }));
  }

  it('lets the official HttpAgent drive an investigation, and replays it from any event', async () => {
    const agent = new HttpAgent({ url: `${base}/api/v1/ag-ui`, threadId: issueId });
    const seen: string[] = [];
    await agent.runAgent({}, { onEvent: ({ event }) => void seen.push(event.type) });
    expect(seen[0]).toBe('RUN_STARTED');
    expect(seen.at(-1)).toBe('RUN_FINISHED');
    // 离线脚本跑完：报告进了共享状态，引用全部核验；工具调用和结果成了标准消息。
    expect(agent.state).toMatchObject({
      issueId,
      engine: 'local',
      status: 'completed',
      report: { verification: { allVerified: true } },
    });
    const toolNames = agent.messages.flatMap((message) =>
      message.role === 'assistant'
        ? (message.toolCalls ?? []).map((call) => call.function.name)
        : [],
    );
    expect(toolNames).toContain('find_suspect_commits');
    expect(agent.messages.filter((message) => message.role === 'tool')).toHaveLength(
      toolNames.length,
    );

    // 同一次调查按 GET 回放；从一条记录中间续传，正好接上，不重也不漏。
    const runId = (agent.state as { runId: string }).runId;
    const full = await readStream(await fetch(`${base}/api/v1/investigations/${runId}/ag-ui`));
    expect(full.map(({ event }) => event.type)).toEqual(seen);
    const middle = full.findIndex(({ event }) => event.type === 'TOOL_CALL_ARGS');
    const resumed = await readStream(
      await fetch(`${base}/api/v1/investigations/${runId}/ag-ui`, {
        headers: { 'last-event-id': full[middle]!.id },
      }),
    );
    expect(resumed).toEqual(full.slice(middle + 1));
    // 已经发完了：204，EventSource 不再重连。
    const done = await fetch(
      `${base}/api/v1/investigations/${runId}/ag-ui?after=${full.at(-1)!.id}`,
    );
    expect(done.status).toBe(204);
  });

  it('rejects input that is not a RunAgentInput and threads that are not issues', async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/v1/ag-ui`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const invalid = await post({ threadId: issueId });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'INVALID_RUN_AGENT_INPUT' });
    const unknown = await post({
      threadId: 'not-an-issue',
      runId: 'r',
      messages: [],
      tools: [],
      context: [],
    });
    expect(unknown.status).toBe(404);
  });
});
