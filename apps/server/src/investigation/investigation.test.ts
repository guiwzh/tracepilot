import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InvestigationRun, InvestigationStreamEvent } from '@trace-pilot/shared';
import { buildApp, type BuildAppOptions } from '../app';
import type { ServerConfig } from '../config';
import { createDatabase } from '../db/client';
import { seedDemoData, seedDemoSourceMaps } from '../seed';
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
  };
  // 种子数据先写入同一个库文件，再由 buildApp 打开。
  const database = createDatabase(config.databasePath);
  seedDemoData(database);
  await seedDemoSourceMaps(database, config.sourceMapDir);
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

function toolOutput(request: ModelRequest, toolCallId: string): string {
  const message = request.messages.find(
    (item) => item.role === 'tool' && item.tool_call_id === toolCallId,
  );
  return String(message?.content ?? '');
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
    expect(events.usage.toolCalls).toBe(5);
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
    ]);
    expect(stream.at(-1)?.event.type).toBe('run.completed');
  });

  it('sends a report back when it cites a call that never happened, and accepts the correction', async () => {
    const { client, requests } = scripted([
      () => turn([{ id: 'call_overview', name: 'get_issue_overview', arguments: '{}' }]),
      () =>
        turn([
          {
            id: 'call_submit_1',
            name: 'submit_report',
            arguments: JSON.stringify(report('call_invented', 'the cart was empty')),
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
            arguments: JSON.stringify(report('call_overview', output.issue.title.slice(0, 40))),
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
    expect(toolOutput(requests[2]!, 'call_submit_1')).toContain('was never called');
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
              arguments: JSON.stringify(
                report('call_overview', 'database connection pool exhausted'),
              ),
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
            arguments: JSON.stringify(report(id, output.issue.title.slice(0, 30))),
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
        { database, issueId: target, projectId: 'demo-project', allowSourceContext: true },
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

function report(toolCallId: string, quote: string) {
  return {
    summary: 'The cart summary was missing when the total was calculated.',
    evidence: [{ toolCallId, quote, description: 'Issue title.', source: 'issue' }],
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
