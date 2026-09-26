import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { buildApp } from './app';
import type { ServerConfig } from './config';

// Fastify app.inject 测试真实路由和 SQLite 行为，同时避免监听网络端口。
let directory: string;
let app: Awaited<ReturnType<typeof buildApp>>;

function event(id: string, dynamicId: string, timestamp = Date.now()): MonitorEvent {
  return {
    eventId: id,
    eventType: 'error',
    timestamp,
    projectId: 'demo-project',
    release: '2.4.1',
    environment: 'production',
    page: { url: `https://shop.test/checkout?token=${dynamicId}`, route: '/checkout' },
    user: { id: `user-${dynamicId}` },
    device: { userAgent: 'Mozilla/5.0 Chrome/130.0', language: 'en-US' },
    payload: {
      name: 'TypeError',
      message: `Cannot read cart for order ${dynamicId}`,
      stack: `TypeError: Cannot read cart\n    at submit (https://shop.test/assets/app.aabbccdd.js:1:420)`,
      authorization: 'Bearer should-never-be-stored',
    },
    breadcrumbs: [],
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-'));
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    databasePath: join(directory, 'test.db'),
    sourceMapDir: join(directory, 'maps'),
    modelName: 'test-model',
  };
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

describe('telemetry ingestion', () => {
  it('rejects malformed input without crashing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: { events: [] },
    });
    expect(response.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('aggregates normalized errors, redacts secrets, and is idempotent', async () => {
    const payload = {
      dsnKey: 'demo-dsn-key',
      sentAt: Date.now(),
      events: [event('evt-one', '93849202'), event('evt-two', '72849201')],
    };
    const response = await app.inject({ method: 'POST', url: '/api/v1/envelopes', payload });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 2, duplicates: 0 });

    const issues = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/issues?page=1&pageSize=25',
    });
    expect(issues.json().total).toBe(1);
    expect(issues.json().items[0]).toMatchObject({ eventCount: 2, userCount: 2 });

    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/envelopes', payload });
    expect(duplicate.json()).toMatchObject({ accepted: 0, duplicates: 2 });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issues.json().items[0].id}`,
    });
    expect(detail.body).not.toContain('should-never-be-stored');
    expect(detail.body).toContain('[REDACTED]');
    expect(detail.json().sampleEvent.pageUrl).toBe('https://shop.test/checkout');
  });

  it('counts each affected user once no matter how many events they send', async () => {
    // Issue 计数是增量累加的，因此“该用户是否已出现过”必须在事件落库之前判定。
    // 若判定挪到插入之后，就会查到刚写入的那一行，user_count 将永远停在 0。
    const repeatUser = (id: string, dynamicId: string): MonitorEvent => ({
      ...event(id, dynamicId),
      user: { id: 'shopper-7' },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [repeatUser('evt-a', '11110001'), repeatUser('evt-b', '11110002')],
      },
    });
    expect(first.json()).toMatchObject({ accepted: 2 });

    // 第二个信封是独立事务，用来覆盖跨批次的去重判定。
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [repeatUser('evt-c', '11110003')],
      },
    });

    const issues = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/issues?page=1&pageSize=25',
    });
    expect(issues.json().total).toBe(1);
    expect(issues.json().items[0]).toMatchObject({ eventCount: 3, userCount: 1 });

    // 再来一个不同用户，确认计数确实还会增长，而不是被卡死在 1。
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [{ ...event('evt-d', '11110004'), user: { id: 'shopper-9' } }],
      },
    });
    const updated = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/issues?page=1&pageSize=25',
    });
    expect(updated.json().items[0]).toMatchObject({ eventCount: 4, userCount: 2 });
  });

  it('keeps first and last seen timestamps correct when events arrive out of order', async () => {
    const olderTimestamp = 1_750_000_000_000;
    const newerTimestamp = olderTimestamp + 60_000;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [
          event('newer-event', '93849202', newerTimestamp),
          event('older-event', '72849201', olderTimestamp),
        ],
      },
    });
    expect(response.statusCode).toBe(202);

    const issues = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/issues?page=1&pageSize=25',
    });
    expect(issues.json().items[0]).toMatchObject({
      firstSeenAt: olderTimestamp,
      lastSeenAt: newerTimestamp,
      eventCount: 2,
    });
  });

  it('removes arbitrary URL query values from stored payloads and breadcrumbs', async () => {
    const unsafe = event('privacy-event', '93849202');
    unsafe.page.url = 'https://shop.test/checkout?campaign=private-campaign#payment';
    unsafe.page.referrer = 'https://search.test/results?query=private-search';
    unsafe.payload.requestUrl = 'https://api.test/orders?experiment=private-variant';
    unsafe.breadcrumbs = [
      {
        id: 'network-breadcrumb',
        type: 'network',
        category: 'http',
        message: 'GET /orders?source=private-source → 503',
        timestamp: unsafe.timestamp - 1,
        data: { url: '/orders?source=private-source', callbackUrl: '/done?code=private-code' },
      },
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: { dsnKey: 'demo-dsn-key', sentAt: Date.now(), events: [unsafe] },
    });
    expect(response.statusCode).toBe(202);
    const issueId = response.json().issueIds[0] as string;
    const detail = await app.inject({ method: 'GET', url: `/api/v1/issues/${issueId}` });

    expect(detail.body).not.toContain('private-campaign');
    expect(detail.body).not.toContain('private-search');
    expect(detail.body).not.toContain('private-variant');
    expect(detail.body).not.toContain('private-source');
    expect(detail.body).not.toContain('private-code');
    expect(detail.json().sampleEvent).toMatchObject({
      pageUrl: 'https://shop.test/checkout',
      context: {
        page: {
          url: 'https://shop.test/checkout',
          referrer: 'https://search.test/results',
        },
        payload: { requestUrl: 'https://api.test/orders' },
      },
      breadcrumbs: [
        {
          message: 'GET /orders → 503',
          data: { url: '/orders', callbackUrl: '/done' },
        },
      ],
    });
  });

  it('keeps performance samples outside the issue stream', async () => {
    const metric = {
      ...event('metric-one', '12345678'),
      eventType: 'performance' as const,
      payload: { metric: 'LCP', value: 2100, rating: 'good' },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: { dsnKey: 'demo-dsn-key', sentAt: Date.now(), events: [metric] },
    });
    expect(response.json().issueIds).toEqual([]);
    const metrics = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/performance',
    });
    expect(
      metrics.json().items.find((item: { metric: string }) => item.metric === 'LCP'),
    ).toMatchObject({
      p75: 2100,
      samples: 1,
    });
    expect(metrics.json()).toMatchObject({
      byRelease: [{ metric: 'LCP', name: '2.4.1', p75: 2100, samples: 1 }],
      byRoute: [{ metric: 'LCP', name: '/checkout', p75: 2100, samples: 1 }],
      byBrowser: [{ metric: 'LCP', name: 'Chrome', p75: 2100, samples: 1 }],
    });
    expect(
      metrics
        .json()
        .trend.find((item: { metric: string; samples: number }) =>
          Boolean(item.metric === 'LCP' && item.samples),
        ),
    ).toMatchObject({ metric: 'LCP', p75: 2100, samples: 1 });
    const projects = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(projects.json().items[0]).toMatchObject({ issueCount: 0, eventCount: 1 });
  });

  it('overwrites a Web Vital reported again under the same metric id', async () => {
    // web-vitals 在页面生命周期里会以同一个 id 报出更大的 LCP/CLS/INP；按 id 覆盖，
    // 一次访问只贡献一个样本，否则多个中间值会把 p75 拉偏。
    const now = Date.now();
    const lcp = (eventId: string, value: number, timestamp: number) => ({
      ...event(eventId, '12345678', timestamp),
      eventType: 'performance' as const,
      payload: { metric: 'LCP', value, rating: 'good', metricId: 'v6-1727000000000-42' },
    });
    const send = (events: MonitorEvent[]) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/envelopes',
        payload: { dsnKey: 'demo-dsn-key', sentAt: now, events },
      });
    const lcpSummary = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/projects/demo-project/performance' }))
        .json()
        .items.find((item: { metric: string }) => item.metric === 'LCP');

    expect((await send([lcp('first-report', 1_200, now - 2_000)])).json()).toMatchObject({
      accepted: 1,
    });
    expect((await send([lcp('grown-report', 2_400, now)])).json()).toMatchObject({
      accepted: 0,
      metricUpdates: 1,
    });
    expect(await lcpSummary()).toMatchObject({ p75: 2_400, samples: 1 });

    // 重试或补发的旧值晚到：以采集时间为准，不能覆盖已入库的新值。
    await send([lcp('stale-retry', 1_200, now - 2_000)]);
    expect(await lcpSummary()).toMatchObject({ p75: 2_400, samples: 1 });
  });

  it('accepts envelopes sent as text/plain so browsers skip the CORS preflight', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify({
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [event('plain-text', '55512345')],
      }),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1 });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: '{"dsnKey":',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('normalizes invalid pagination and event limit query values', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [event('query-event-one', '93849202'), event('query-event-two', '72849201')],
      },
    });
    const issues = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/issues?page=not-a-number&pageSize=-20',
    });
    expect(issues.statusCode).toBe(200);
    expect(issues.json()).toMatchObject({ page: 1, pageSize: 1, total: 1 });

    const issueId = issues.json().items[0].id as string;
    const events = await app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issueId}/events?limit=-1`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().items).toHaveLength(1);
  });

  it('generates a schema-valid diagnosis and reuses an unchanged context', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [event('diagnosis-event', '88392014')],
      },
    });
    const issues = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/issues?page=1&pageSize=25',
    });
    const issueId = issues.json().items[0].id as string;
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issueId}/diagnoses`,
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      issueId,
      model: 'local-evidence-engine',
      cached: false,
      result: { possibleCauses: expect.any(Array), evidence: expect.any(Array) },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issueId}/diagnoses`,
      payload: {},
    });
    expect(second.json()).toMatchObject({ id: first.json().id, cached: true });
  });
});
