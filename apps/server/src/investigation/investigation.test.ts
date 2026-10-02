import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InvestigationRun, InvestigationStreamEvent } from '@trace-pilot/shared';
import { buildApp, type BuildAppOptions } from '../app';
import type { ServerConfig } from '../config';
import { createDatabase } from '../db/client';
import { buildDiagnosisContext } from '../services/diagnosis';
import { demoTrace, seedDemoData } from '../seed';
import type { ModelClient, ModelRequest, ModelTurn } from './model';
import { runTool } from './tools';

/**
 * 排障 Agent 的集成测试。模型被替换成按剧本出牌的替身（或离线脚本引擎），
 * 其余一切都是真的：工具查真实 SQLite，引用校验、事件落库、SSE 回放都走生产代码。
 */
let directory: string;
let config: ServerConfig;
let app: Awaited<ReturnType<typeof buildApp>>;

async function start(options: Partial<BuildAppOptions> = {}) {
  app = await buildApp({ config, logger: false, ...options });
  await app.ready();
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-investigation-'));
  config = {
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
  // 种子数据先写入同一个库文件，再由 buildApp 打开；演示 git 仓库建在临时目录里。
  const database = createDatabase(config.databasePath);
  await seedDemoData(database, config.sourceMapDir, config.repositoryRoot);
  database.close();
});

afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

async function issueId(titleFragment: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/demo-project/issues?pageSize=100&search=${encodeURIComponent(titleFragment)}`,
  });
  return (response.json() as { items: Array<{ id: string }> }).items[0]!.id;
}

async function startRun(id: string): Promise<InvestigationRun> {
  const response = await app.inject({ method: 'POST', url: `/api/v1/issues/${id}/investigations` });
  expect(response.statusCode).toBe(201);
  return response.json() as InvestigationRun;
}

async function waitForEnd(runId: string): Promise<InvestigationRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = (
      await app.inject({ method: 'GET', url: `/api/v1/investigations/${runId}` })
    ).json() as InvestigationRun;
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('investigation did not finish');
}

/** 按剧本逐轮返回的模型替身；每一轮拿到完整请求，可以据此断言循环给模型看了什么。 */
function scripted(turns: Array<(request: ModelRequest) => ModelTurn | Promise<ModelTurn>>) {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    engine: 'model',
    model: 'scripted-test-model',
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const turn = turns[requests.length - 1];
      if (!turn) throw new Error(`no scripted turn ${requests.length}`);
      return turn(request);
    },
  };
  return { client, requests };
}

const usage = { inputTokens: 10, outputTokens: 5 };
const turn = (toolCalls: ModelTurn['toolCalls'], text = ''): ModelTurn => ({
  text,
  toolCalls,
  usage,
});

/** 模型看到的工具结果正文：第一行是 "ref: T1 (tool_name)"，之后是 JSON。 */
function toolContent(request: ModelRequest, toolCallId: string): string {
  const message = request.messages.find(
    (item) => item.role === 'tool' && item.tool_call_id === toolCallId,
  );
  return String(message?.content ?? '');
}

function toolOutput(request: ModelRequest, toolCallId: string): string {
  return toolContent(request, toolCallId).replace(/^ref: T\d+[^\n]*\n/, '');
}

describe('investigation agent', () => {
  it('runs the offline investigation end to end with every citation verified', async () => {
    await start();
    const id = await issueId("reading 'total'");
    const run = await startRun(id);
    expect(run).toMatchObject({ status: 'running', engine: 'local' });

    const finished = await waitForEnd(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.report?.verification).toMatchObject({ allVerified: true, problems: [] });
    // 源码片段来自种子 Source Map 里内联的 sourcesContent。
    expect(finished.report?.evidence).toContainEqual(
      expect.objectContaining({
        source: 'source',
        quote: expect.stringContaining('cart.summary.total'),
      }),
    );

    const events = (
      await app.inject({ method: 'GET', url: `/api/v1/investigations/${run.id}` })
    ).json() as InvestigationRun;
    expect(events.usage.toolCalls).toBe(6);
    const stream = await readStream(run.id, 0);
    expect(stream.map((record) => record.seq)).toEqual(stream.map((_, index) => index + 1));
    expect(
      stream
        .filter((record) => record.event.type === 'tool.called')
        .map((record) => (record.event.type === 'tool.called' ? record.event.name : '')),
    ).toEqual([
      'get_issue_overview',
      'list_event_samples',
      'get_event_detail',
      'compare_releases',
      'get_source_context',
      'find_suspect_commits',
    ]);
    // 嫌疑提交：出错那一行最后是被 2.4.1 之前的那次性能优化改的，引用它的提交说明并通过核验。
    expect(finished.report?.evidence).toContainEqual(
      expect.objectContaining({
        source: 'commit',
        quote: expect.stringContaining('reuse the cart summary total'),
        verified: true,
      }),
    );
    expect(stream.at(-1)?.event.type).toBe('run.completed');
  });

  it('points at the backend trace of a failed request instead of guessing what the backend did', async () => {
    await start();
    // 种子数据假定商店给 api.shop.example 开了 trace 传播：失败的支付请求带着 traceparent。
    const finished = await waitForEnd((await startRun(await issueId('payment/authorize'))).id);
    expect(finished.status).toBe('completed');
    const stream = await readStream(finished.id, 0);
    const detailCall = stream.find(
      (record) => record.event.type === 'tool.called' && record.event.name === 'get_event_detail',
    )!.event as Extract<InvestigationStreamEvent['event'], { type: 'tool.called' }>;
    const detailResult = stream.find(
      (record) =>
        record.event.type === 'tool.completed' && record.event.toolCallId === detailCall.toolCallId,
    )!.event as Extract<InvestigationStreamEvent['event'], { type: 'tool.completed' }>;
    const detail = JSON.parse(detailResult.output) as {
      eventId: string;
      traceId: string;
      failedRequests: string[];
    };
    const trace = demoTrace(detail.eventId);
    expect(detail.traceId).toBe(trace.traceId);
    expect(detail.failedRequests[0]).toMatch(
      new RegExp(
        `POST https://api.shop.example/payment/authorize → 503 .*\\[trace ${trace.traceId} span ${trace.span('payment')}\\]$`,
      ),
    );
    // 调查读不到链路系统：报告点名要去看的那个 trace 和 span。
    expect(finished.report?.missingInformation).toContain(
      `The backend side of trace ${trace.traceId} (span ${trace.span('payment')}): open it in the tracing system to see what the backend did.`,
    );
  });

  it('sends a report back when it cites a call that never happened, and accepts the correction', async () => {
    const { client, requests } = scripted([
      () => turn([{ id: 'call_overview', name: 'get_issue_overview', arguments: '{}' }]),
      () =>
        turn([
          {
            id: 'call_submit_1',
            name: 'submit_report',
            // 引用了一个不存在的编号，就像模型编造 tool_call_id 那样。
            arguments: JSON.stringify(report('T99', 'the cart was empty')),
          },
        ]),
      (request) => {
        // 从真实的工具结果里摘一段原文，引用才能通过校验。
        const output = JSON.parse(toolOutput(request, 'call_overview')) as {
          issue: { title: string };
        };
        return turn([
          {
            id: 'call_submit_2',
            name: 'submit_report',
            arguments: JSON.stringify(report('T1', output.issue.title.slice(0, 40))),
          },
        ]);
      },
    ]);
    await start({ modelClientFactory: () => client });
    const run = await startRun(await issueId("reading 'total'"));
    const finished = await waitForEnd(run.id);

    expect(finished.status).toBe('completed');
    expect(finished.report?.verification).toMatchObject({ attempts: 2, allVerified: true });
    // 驳回理由作为 submit_report 的工具结果回到模型手里。
    expect(toolContent(requests[2]!, 'call_submit_1')).toContain('does not match any tool result');
    // 模型能读到的编号写在结果正文的第一行，而不是只存在于消息元数据里的 tool_call_id。
    expect(toolContent(requests[1]!, 'call_overview')).toMatch(/^ref: T1 \(get_issue_overview\)\n/);
    const stream = await readStream(run.id, 0);
    expect(stream.some((record) => record.event.type === 'report.rejected')).toBe(true);
  });

  it('flags a quote that does not appear in the cited result', async () => {
    const { client } = scripted([
      () => turn([{ id: 'call_overview', name: 'get_issue_overview', arguments: '{}' }]),
      ...Array.from(
        { length: 3 },
        (_, index) => () =>
          turn([
            {
              id: `call_submit_${index}`,
              name: 'submit_report',
              arguments: JSON.stringify(report('T1', 'database connection pool exhausted')),
            },
          ]),
      ),
    ]);
    await start({ modelClientFactory: () => client });
    const run = await startRun(await issueId("reading 'total'"));
    const finished = await waitForEnd(run.id);

    // 重交次数用尽后仍接受报告，但未通过的引用被如实标出，而不是当作已核实。
    expect(finished.status).toBe('completed');
    expect(finished.report?.evidence[0]?.verified).toBe(false);
    expect(finished.report?.verification.allVerified).toBe(false);
    expect(finished.report?.verification.problems[0]).toContain('not found verbatim');
  });

  it('forces a report through submit_report once the step budget is spent', async () => {
    const overview = (request: ModelRequest) =>
      request.toolChoice === 'auto'
        ? turn([{ id: `call_${Math.random()}`, name: 'get_issue_overview', arguments: '{}' }])
        : turn([]);
    const { client, requests } = scripted([
      overview,
      overview,
      (request) => {
        const called = request.messages.find((item) => item.role === 'tool');
        const id = called?.role === 'tool' ? called.tool_call_id : '';
        const output = JSON.parse(toolOutput(request, id)) as { issue: { title: string } };
        return turn([
          {
            id: 'call_submit',
            name: 'submit_report',
            arguments: JSON.stringify(report('T1', output.issue.title.slice(0, 30))),
          },
        ]);
      },
    ]);
    await start({ modelClientFactory: () => client, investigationLimits: { maxSteps: 2 } });
    const run = await startRun(await issueId("reading 'total'"));
    const finished = await waitForEnd(run.id);

    expect(finished.status).toBe('completed');
    const last = requests.at(-1)!;
    expect(last.toolChoice).toEqual({ name: 'submit_report' });
    expect(last.tools.map((tool) => tool.function.name)).toEqual(['submit_report']);
  });

  it('shows the model the cause chain even below a long outer stack', async () => {
    await start();
    const outer = Array.from(
      { length: 14 },
      (_, index) => `    at layer${index} (https://shop.example/assets/app.js:1:${index + 10})`,
    );
    const stack = [
      'Error: Checkout failed',
      ...outer,
      'Caused by: TypeError: Failed to fetch',
      '    at request (https://shop.example/assets/api.js:2:30)',
    ].join('\n');
    const ingest = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [
          {
            eventId: 'wrapped-failure',
            eventType: 'error',
            timestamp: Date.now(),
            projectId: 'demo-project',
            release: '2.4.1',
            environment: 'production',
            page: { url: 'https://shop.example/checkout' },
            device: { userAgent: 'Chrome/140' },
            payload: { name: 'Error', message: 'Checkout failed', stack },
            breadcrumbs: [],
          },
        ],
      },
    });
    const [issue] = (ingest.json() as { issueIds: string[] }).issueIds;
    const database = createDatabase(config.databasePath);
    try {
      const result = await runTool(
        'get_event_detail',
        JSON.stringify({ eventId: 'wrapped-failure' }),
        {
          database,
          issueId: issue!,
          projectId: 'demo-project',
          allowSourceContext: true,
          repositoryRoot: null,
        },
      );
      const detail = JSON.parse(result.output.slice(result.output.indexOf('{'))) as {
        stack: string;
      };
      // 最外层只留前 12 行，但根因所在的 cause 段仍在。
      expect(detail.stack.split('\n')).toHaveLength(12 + 2);
      expect(detail.stack).toContain('Caused by: TypeError: Failed to fetch');
      expect(detail.stack).toContain('at request (https://shop.example/assets/api.js:2:30)');
    } finally {
      database.close();
    }
  });

  it('counts requests that got no response as failed, but not cancelled ones', async () => {
    // 回归：失败请求只挑状态码 ≥ 400 的，断网、跨域被拦这类拿不到响应的请求（状态码 0）
    // 从不出现在失败请求里，Agent 和单次诊断都看不到它们。
    await start();
    const now = Date.now();
    const request = (id: string, url: string, data: Record<string, unknown>, before: number) => ({
      id,
      type: 'network',
      category: 'http',
      message: `GET ${url}`,
      timestamp: now - before,
      data: { method: 'GET', url, duration: 120, ...data },
    });
    const ingest = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: now,
        events: [
          {
            eventId: 'offline-failure',
            eventType: 'error',
            timestamp: now,
            projectId: 'demo-project',
            release: '2.4.1',
            environment: 'production',
            page: { url: 'https://shop.example/checkout' },
            device: { userAgent: 'Chrome/140' },
            payload: { name: 'TypeError', message: 'Failed to fetch' },
            breadcrumbs: [
              request(
                'cart',
                'https://shop.example/api/cart',
                { status: 200, success: true },
                3_000,
              ),
              request(
                'search',
                'https://shop.example/api/search',
                { status: 0, success: false, aborted: true },
                2_000,
              ),
              request(
                'pay',
                'https://shop.example/api/pay',
                { status: 0, success: false, error: 'Failed to fetch' },
                1_000,
              ),
            ],
          },
        ],
      },
    });
    const [issue] = (ingest.json() as { issueIds: string[] }).issueIds;
    const database = createDatabase(config.databasePath);
    try {
      const result = await runTool(
        'get_event_detail',
        JSON.stringify({ eventId: 'offline-failure' }),
        {
          database,
          issueId: issue!,
          projectId: 'demo-project',
          allowSourceContext: true,
          repositoryRoot: null,
        },
      );
      const detail = JSON.parse(result.output) as { failedRequests: string[]; timeline: string[] };
      expect(detail.failedRequests).toEqual([
        '-1.0s network GET https://shop.example/api/pay → network error (Failed to fetch) (120 ms)',
      ]);
      // 被取消的请求不算失败，时间线里写明是取消，而不是一个看不出原因的状态码 0。
      expect(detail.timeline).toContain(
        '-2.0s network GET https://shop.example/api/search → aborted (120 ms)',
      );
      // 单次诊断的证据快照用同一条规则。
      expect(buildDiagnosisContext(database, issue!)?.recentEvents[0]?.failedRequests).toEqual([
        {
          method: 'GET',
          url: 'https://shop.example/api/pay',
          status: 0,
          duration: 120,
          error: 'Failed to fetch',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps tools scoped to the issue under investigation', async () => {
    await start();
    const target = await issueId("reading 'total'");
    const other = await issueId('warehouseId');
    const otherEvent = (
      await app.inject({ method: 'GET', url: `/api/v1/issues/${other}/events?limit=1` })
    ).json() as { items: Array<{ id: string }> };
    const database = createDatabase(config.databasePath);
    try {
      const result = await runTool(
        'get_event_detail',
        JSON.stringify({ eventId: otherEvent.items[0]!.id }),
        {
          database,
          issueId: target,
          projectId: 'demo-project',
          allowSourceContext: true,
          repositoryRoot: null,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.output).toContain('EVENT_NOT_FOUND');
    } finally {
      database.close();
    }
  });

  it('cancels a running investigation and reuses it for repeated starts', async () => {
    const hanging: ModelClient = {
      engine: 'model',
      model: 'hanging-model',
      complete: ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        ),
    };
    await start({ modelClientFactory: () => hanging });
    const id = await issueId("reading 'total'");
    const run = await startRun(id);

    // 重复点击接到同一次运行，而不是再开一次计费的调查。
    const again = await app.inject({ method: 'POST', url: `/api/v1/issues/${id}/investigations` });
    expect(again.statusCode).toBe(200);
    expect((again.json() as InvestigationRun).id).toBe(run.id);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/investigations/${run.id}/cancel`,
    });
    expect(cancel.statusCode).toBe(202);
    expect((await waitForEnd(run.id)).status).toBe('cancelled');
    expect(
      (await app.inject({ method: 'POST', url: `/api/v1/investigations/${run.id}/cancel` }))
        .statusCode,
    ).toBe(409);
  });

  it('replays missed events over SSE from Last-Event-ID and stops once the run has ended', async () => {
    await start();
    const run = await startRun(await issueId("reading 'total'"));
    await waitForEnd(run.id);
    const all = await readStream(run.id, 0);

    const resumed = await readStream(run.id, 3);
    expect(resumed[0]?.seq).toBe(4);
    expect(resumed.map((record) => record.seq)).toEqual(all.slice(3).map((record) => record.seq));

    // 已结束且没有新事件：204 让 EventSource 停止重连。
    const done = await fetch(`${await baseUrl()}/api/v1/investigations/${run.id}/events`, {
      headers: { 'last-event-id': String(all.at(-1)!.seq) },
    });
    expect(done.status).toBe(204);
  });
});

function report(resultRef: string, quote: string) {
  return {
    summary: 'The cart summary was missing when the total was calculated.',
    evidence: [{ resultRef, quote, description: 'Issue title.', source: 'issue' }],
    possibleCauses: [{ cause: 'A missing guard.', confidence: 0.6, evidenceRefs: [0] }],
    investigationSteps: ['Check the mapped frame.'],
    suggestions: ['Guard the optional field.'],
    missingInformation: [],
  };
}

/** SSE 需要真实的 socket（app.inject 模拟不了流式响应），首次调用时才监听端口。 */
async function baseUrl(): Promise<string> {
  const address = app.server.address() as AddressInfo | null;
  return address ? `http://127.0.0.1:${address.port}` : app.listen({ port: 0, host: '127.0.0.1' });
}

async function readStream(runId: string, after: number): Promise<InvestigationStreamEvent[]> {
  const response = await fetch(`${await baseUrl()}/api/v1/investigations/${runId}/events`, {
    headers: { 'last-event-id': String(after) },
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice('data: '.length)) as InvestigationStreamEvent);
}
