import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MonitorEvent } from '@trace-pilot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import {
  ALERT_LIMITS,
  AlertDispatcher,
  createAlertRule,
  listAlertDeliveries,
  retryDelay,
  sendTestAlert,
  updateAlertRule,
} from './alerts';
import { ingestEnvelope } from './events';
import { setIssueStatus } from './lifecycle';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let directory: string;
let database: TraceDatabase;
let server: Server;
let hookUrl: string;
let received: Received[];
/** 接下来几次请求依次返回的状态码，用完之后都是 200。 */
let statuses: number[];
let clock: number;
let dispatcher: AlertDispatcher;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-alerts-'));
  database = createDatabase(join(directory, 'test.db'));
  ensureDemoProject(database);
  received = [];
  statuses = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.statusCode = statuses.shift() ?? 200;
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  clock = NOW;
  dispatcher = new AlertDispatcher(database, {
    dashboardUrl: 'http://localhost:4173',
    now: () => clock,
  });
});

afterEach(async () => {
  await dispatcher.close();
  await new Promise((resolve) => server.close(resolve));
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function failure(
  id: string,
  timestamp: number,
  overrides: Partial<MonitorEvent> = {},
): MonitorEvent {
  return {
    eventId: id,
    eventType: 'error',
    timestamp,
    projectId: 'demo-project',
    release: '2.4.1',
    environment: 'production',
    page: { url: 'https://shop.test/checkout' },
    device: { userAgent: 'Chrome/130' },
    payload: { name: 'TypeError', message: 'Checkout failed' },
    breadcrumbs: [],
    ...overrides,
  };
}

async function ingest(events: MonitorEvent[], receivedAt = clock) {
  return ingestEnvelope(
    database,
    { dsnKey: 'demo-dsn-key', sentAt: receivedAt, events },
    receivedAt,
  );
}

function rule(overrides: Partial<Parameters<typeof createAlertRule>[2]> = {}) {
  return createAlertRule(
    database,
    'demo-project',
    {
      name: 'On call',
      triggers: ['new_issue', 'regression', 'escalating'],
      minLevel: 'error',
      intervalMinutes: 60,
      channel: { type: 'webhook', url: hookUrl, secret: 'hook-secret' },
      ...overrides,
    },
    NOW - 60_000,
  );
}

const statusesOf = () =>
  listAlertDeliveries(database, 'demo-project', 50).map((item) => [
    item.trigger,
    item.status,
    item.reason,
  ]);

describe('alert dispatch', () => {
  it('turns a new issue into one signed webhook with a link back to the issue', async () => {
    rule();
    const { result } = await ingest([failure('a', NOW - 1_000)]);
    await dispatcher.run();

    expect(received).toHaveLength(1);
    const [request] = received;
    const signature = createHmac('sha256', 'hook-secret')
      .update(`${String(request!.headers['x-tracepilot-timestamp'])}.${request!.body}`)
      .digest('hex');
    expect(request!.headers['x-tracepilot-signature']).toBe(`sha256=${signature}`);
    const body = JSON.parse(request!.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      trigger: 'new_issue',
      project: { id: 'demo-project' },
      issue: { id: result.issueIds[0], release: '2.4.1' },
      detail: 'First seen in release 2.4.1.',
      url: `http://localhost:4173/projects/demo-project/issues/${result.issueIds[0]}`,
    });
    expect(statusesOf()).toEqual([['new_issue', 'sent', null]]);

    // 活动记录已处理：再跑一轮不会重发。
    await dispatcher.run();
    expect(received).toHaveLength(1);
  });

  it('suppresses repeats inside the interval and while muted, and records why', async () => {
    const created = rule({ intervalMinutes: 30 });
    const { result } = await ingest([failure('a', NOW - 1_000)]);
    await dispatcher.run();
    const issueId = result.issueIds[0]!;

    // 十分钟后解决又回归：同一个 Issue 还在 30 分钟的去重窗口里。
    clock = NOW + 10 * 60_000;
    setIssueStatus(database, issueId, 'resolved', false, clock - 60_000);
    await ingest([failure('b', clock - 1_000)]);
    await dispatcher.run();

    // 静默期间的新 Issue 不发。
    updateAlertRule(database, created.id, { mutedUntil: clock + 3_600_000 });
    await ingest([
      failure('c', clock - 500, { payload: { name: 'RangeError', message: 'Other' } }),
    ]);
    await dispatcher.run();

    expect(received).toHaveLength(1);
    expect(statusesOf()).toEqual([
      ['new_issue', 'suppressed', 'muted'],
      ['regression', 'suppressed', 'interval'],
      ['new_issue', 'sent', null],
    ]);
  });

  it('only alerts on the triggers and levels a rule asks for', async () => {
    rule({ triggers: ['regression'] });
    rule({ name: 'Warnings too', minLevel: 'warning', triggers: ['new_issue'] });
    // 4xx 的失败请求是 warning 级：只有第二条规则接受。
    await ingest([
      failure('w', NOW - 1_000, {
        eventType: 'network',
        payload: { method: 'GET', url: 'https://api.shop.test/cart', status: 404, success: false },
      }),
    ]);
    await dispatcher.run();
    expect(listAlertDeliveries(database, 'demo-project').map((item) => item.ruleName)).toEqual([
      'Warnings too',
    ]);
  });

  it('retries failed sends with backoff and gives up after the last attempt', async () => {
    rule();
    statuses = [500, 503];
    await ingest([failure('a', NOW - 1_000)]);
    await dispatcher.run();
    expect(statusesOf()).toEqual([['new_issue', 'pending', 'HTTP 500: ok']]);

    // 没到重试时间不发。
    clock = NOW + retryDelay(1) - 1;
    await dispatcher.run();
    expect(received).toHaveLength(1);

    clock = NOW + retryDelay(1);
    await dispatcher.run();
    clock += retryDelay(2);
    await dispatcher.run();
    expect(received).toHaveLength(3);
    expect(listAlertDeliveries(database, 'demo-project')[0]).toMatchObject({
      status: 'sent',
      attempts: 3,
      reason: null,
    });

    // 一直失败：用完次数后标记为失败，不再重试。
    statuses = Array.from({ length: ALERT_LIMITS.maxAttempts }, () => 500);
    await ingest([failure('x', clock - 1_000, { payload: { name: 'Error', message: 'Always' } })]);
    for (let attempt = 1; attempt <= ALERT_LIMITS.maxAttempts + 1; attempt += 1) {
      await dispatcher.run();
      clock += retryDelay(attempt);
    }
    expect(listAlertDeliveries(database, 'demo-project')[0]).toMatchObject({
      status: 'failed',
      attempts: ALERT_LIMITS.maxAttempts,
    });
  });

  it('caps each rule per hour and ignores stale activity', async () => {
    rule();
    await ingest(
      Array.from({ length: ALERT_LIMITS.perRulePerHour + 2 }, (_, index) =>
        failure(`n${index}`, NOW - 1_000, {
          payload: { name: 'Error', message: `Distinct ${index}` },
        }),
      ),
    );
    await dispatcher.run();
    const deliveries = listAlertDeliveries(database, 'demo-project', 100);
    expect(deliveries.filter((item) => item.status === 'sent')).toHaveLength(
      ALERT_LIMITS.perRulePerHour,
    );
    expect(deliveries.filter((item) => item.reason === 'rate_limited')).toHaveLength(2);

    // 两小时前写入、一直没处理的活动记录（例如种子脚本写的）：不再告警。
    await ingest(
      [failure('old', NOW - 3 * 3_600_000, { payload: { name: 'Error', message: 'Old' } })],
      NOW - 2 * 3_600_000,
    );
    const before = received.length;
    await dispatcher.run();
    expect(received.length).toBe(before);
  });

  it('drops queued notifications of a rule that was disabled before they went out', async () => {
    const created = rule();
    statuses = [500];
    await ingest([failure('a', NOW - 1_000)]);
    await dispatcher.run();
    updateAlertRule(database, created.id, { enabled: false });
    clock = NOW + retryDelay(1);
    await dispatcher.run();
    expect(received).toHaveLength(1);
    expect(statusesOf()).toEqual([['new_issue', 'suppressed', 'disabled']]);
  });

  it('sends a test notification straight away and logs it', async () => {
    const created = rule();
    expect(
      await sendTestAlert(database, created.id, {
        dashboardUrl: 'http://localhost:4173',
        now: NOW,
      }),
    ).toEqual({ ok: true, status: 200, error: null });
    expect(JSON.parse(received[0]!.body)).toMatchObject({ trigger: 'test' });
    expect(statusesOf()).toEqual([['test', 'sent', null]]);

    await new Promise((resolve) => server.close(resolve));
    const unreachable = await sendTestAlert(database, created.id, {
      dashboardUrl: 'http://localhost:4173',
      now: NOW,
    });
    expect(unreachable).toMatchObject({ ok: false, status: null });
    expect(await sendTestAlert(database, 'missing', { dashboardUrl: '' })).toBeNull();
    // afterEach 还会关一次服务器：重新监听一个端口让它有东西可关。
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
});
