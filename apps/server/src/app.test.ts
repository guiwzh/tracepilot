import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { buildApp } from './app';
import type { ServerConfig } from './config';
import { clearSourceMapCache } from './services/sourcemaps';

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
    localAgentStepDelayMs: 0,
    agentSourceContext: true,
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

  it('reopens a resolved issue when it happens again, but not for events from before the fix', async () => {
    const send = (id: string, timestamp: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/envelopes',
        payload: {
          dsnKey: 'demo-dsn-key',
          sentAt: Date.now(),
          events: [event(id, '51234567', timestamp)],
        },
      });
    const status = async (issueId: string) =>
      (await app.inject({ method: 'GET', url: `/api/v1/issues/${issueId}` })).json().status;
    const issueId = (await send('before-fix', Date.now() - 60_000)).json().issueIds[0];
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${issueId}/status`,
      payload: { status: 'resolved' },
    });

    // 修复之前就发生、只是迟到的事件（例如服务端故障期间积压在 SDK 队列里的）不算回归。
    await send('late-arrival', Date.now() - 30_000);
    expect(await status(issueId)).toBe('resolved');

    // 回归：曾经 Issue 停在「已解决」，概览的未解决数不包含它，按未解决筛选也看不到。
    await send('after-fix', Date.now() + 1_000);
    expect(await status(issueId)).toBe('unresolved');
    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/overview',
    });
    expect(overview.json().unresolvedIssues).toBe(1);
  });

  it('keeps an ignored issue ignored when new events arrive', async () => {
    const send = (id: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/envelopes',
        payload: { dsnKey: 'demo-dsn-key', sentAt: Date.now(), events: [event(id, '51234567')] },
      });
    const issueId = (await send('first')).json().issueIds[0];
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${issueId}/status`,
      payload: { status: 'ignored' },
    });
    await send('second');
    const issue = await app.inject({ method: 'GET', url: `/api/v1/issues/${issueId}` });
    expect(issue.json()).toMatchObject({ status: 'ignored', eventCount: 2 });
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

  it('points at the elements behind the slowest LCP and INP samples', async () => {
    const vital = (id: string, metric: string, value: number, target: string) => ({
      ...event(id, '12345678'),
      eventType: 'performance' as const,
      payload: { metric, value, rating: 'good', metricId: id, attribution: { target } },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [
          vital('lcp-hero-1', 'LCP', 3_800, 'main>img.hero'),
          vital('lcp-hero-2', 'LCP', 4_200, 'main>img.hero'),
          vital('lcp-logo', 'LCP', 1_200, 'header>img.logo'),
          vital('inp-pay', 'INP', 520, 'button#pay'),
        ],
      },
    });
    const overview = (
      await app.inject({ method: 'GET', url: '/api/v1/projects/demo-project/performance' })
    ).json();
    // 每个指标里按 p75 从差到好排：先看拖慢最多的那张图。
    expect(
      overview.byElement.map((item: { metric: string; name: string; samples: number }) => [
        item.metric,
        item.name,
        item.samples,
      ]),
    ).toEqual([
      ['LCP', 'main>img.hero', 2],
      ['LCP', 'header>img.logo', 1],
      ['INP', 'button#pay', 1],
    ]);
  });

  it('counts only issue events and the users who hit them in the overview', async () => {
    // 回归：性能样本曾一并计入「24 小时事件数」和「受影响用户」，
    // 于是每个只上报过一次指标的访客都被算作受影响。
    const sample = (id: string, user: string): MonitorEvent => ({
      ...event(id, '12345678'),
      eventType: 'performance',
      user: { id: user },
      payload: { metric: 'LCP', value: 1800, rating: 'good' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [
          { ...event('broken-checkout', '90000001'), user: { id: 'hit-by-error' } },
          sample('visit-one', 'healthy-visitor-1'),
          sample('visit-two', 'healthy-visitor-2'),
        ],
      },
    });

    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo-project/overview',
    });
    expect(overview.json()).toMatchObject({ events24h: 1, affectedUsers24h: 1 });
    expect(
      overview
        .json()
        .trend.reduce((sum: number, point: { errors: number }) => sum + point.errors, 0),
    ).toBe(1);
  });

  it('keeps the overview trend in step with its totals for events from a fast clock', async () => {
    // 事件时间可以比服务端时钟快一点（容差以内不校正）。这样的事件曾落进第 25 个小时桶：
    // 计入了 24 小时事件数，却不出现在趋势图里。
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [event('slightly-ahead', '30000001', Date.now() + 30_000)],
      },
    });
    const overview = (
      await app.inject({ method: 'GET', url: '/api/v1/projects/demo-project/overview' })
    ).json();
    const trendTotal = overview.trend.reduce(
      (sum: number, point: { errors: number }) => sum + point.errors,
      0,
    );
    expect({ events: overview.events24h, trend: trendTotal }).toEqual({ events: 1, trend: 1 });
  });

  it('draws each issue trend over the last seven whole hours', async () => {
    const minutesAgo = [5, 10, 20, 70, 130, 200];
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: minutesAgo.map((minutes, index) =>
          event(`trend-${index}`, '40000001', Date.now() - minutes * 60_000),
        ),
      },
    });
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects/demo-project/issues' });
    // 最后一个点是刚过去的一小时。回归：窗口曾只有 6 小时，第 7 个点落在「此刻之后」，恒为 0。
    expect(list.json().items[0].trend).toEqual([0, 0, 0, 1, 1, 1, 3]);
  });

  it('filters by exactly the browsers the issue detail shows', async () => {
    const agents: Record<string, string> = {
      Edge: 'Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0',
      Chrome: 'Mozilla/5.0 Chrome/130.0 Safari/537.36',
      Firefox: 'Mozilla/5.0 Gecko/20100101 Firefox/131.0',
      Safari: 'Mozilla/5.0 (iPhone) CriOS/130.0 Mobile/15E148 Safari/604.1',
      Other: 'curl/8.9.1',
    };
    await app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: Object.entries(agents).map(([browser, userAgent]) => ({
          ...event(`browser-${browser}`, '10000001'),
          device: { userAgent },
          payload: { name: 'TypeError', message: `Broken only in ${browser}` },
        })),
      },
    });
    for (const browser of Object.keys(agents)) {
      const filtered = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/demo-project/issues?browser=${browser.toLowerCase()}`,
      });
      // 回归：筛选和分布曾是两套规则，分布里的 Other 按它筛选什么也筛不出来。
      expect(filtered.json().items.map((issue: { title: string }) => issue.title)).toEqual([
        `Broken only in ${browser}`,
      ]);
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/issues/${filtered.json().items[0].id}`,
      });
      expect(detail.json().browserDistribution).toEqual([{ name: browser, value: 1 }]);
    }
  });

  it('lets cross-origin SDKs read Retry-After', async () => {
    // 不在 CORS 默认可读的响应头里；不显式暴露，SDK 就无法照服务端要求的时间退避。
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://shop.test' },
    });
    expect(response.headers['access-control-expose-headers']).toBe('retry-after');
  });

  it('no longer serves the playground-only failure endpoint', async () => {
    // 演示用的故障接口已移到 Playground 的开发服务器里，生产服务不再暴露它。
    const response = await app.inject({ method: 'GET', url: '/api/v1/playground/fail' });
    expect(response.statusCode).toBe(404);
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

    // 重试后才送达的旧值晚到：以采集时间为准，不能覆盖已入库的新值。
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

describe('source map failures', () => {
  function uploadMap(content: string) {
    const boundary = '----tracepilot-test';
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="minifiedFile"\r\n\r\napp.aabbccdd.js\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.js.map"\r\n` +
      `Content-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return app.inject({
      method: 'POST',
      url: '/api/v1/releases/demo-release-2-4-1/source-maps',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  }

  function ingest(id: string, stack?: string) {
    const payload = event(id, '70000001');
    if (stack) payload.payload.stack = stack;
    return app.inject({
      method: 'POST',
      url: '/api/v1/envelopes',
      payload: { dsnKey: 'demo-dsn-key', sentAt: Date.now(), events: [payload] },
    });
  }

  async function originalStackOf(eventId: string): Promise<string | null | undefined> {
    const issueId = (
      await app.inject({ method: 'GET', url: '/api/v1/projects/demo-project/issues' })
    ).json().items[0].id;
    const events = await app.inject({ method: 'GET', url: `/api/v1/issues/${issueId}/events` });
    return events.json().items.find((item: { id: string }) => item.id === eventId)?.originalStack;
  }

  const VALID_MAP = JSON.stringify({
    version: 3,
    file: 'app.aabbccdd.js',
    sources: ['src/cart.ts'],
    names: [],
    // 压缩文件第 1 行第 1 列 → src/cart.ts 第 1 行第 1 列。
    mappings: 'AAAA',
  });

  it('refuses an unparseable map without letting it break later ingestion', async () => {
    // 回归：这样的 map 曾先被登记下来。之后该版本每个带堆栈的错误批次都返回 500，
    // SDK 把整批当作可重试的失败放回队首，后面的事件全部卡在它身后。
    const upload = await uploadMap(
      JSON.stringify({ version: 3, mappings: 'AAAA', sources: 'not-an-array' }),
    );
    expect(upload.statusCode).toBe(400);
    const maps = await app.inject({
      method: 'GET',
      url: '/api/v1/releases/demo-release-2-4-1/source-maps',
    });
    expect(maps.json().items).toEqual([]);
    expect((await ingest('after-bad-map')).statusCode).toBe(202);
  });

  it('refuses a map whose mappings cannot be decoded', async () => {
    // 回归：mappings 要到第一次查询才解码。这份 map 曾以 201 通过上传，之后该版本每一次
    // 带堆栈的接入都返回 500，SDK 的重试也一直是 500。
    const upload = await uploadMap(
      JSON.stringify({ version: 3, sources: ['src/cart.ts'], names: [], mappings: 'AAAA;!!!!' }),
    );
    expect(upload.statusCode).toBe(400);
    expect((await ingest('after-undecodable-map')).statusCode).toBe(202);
  });

  it('accepts the minified file name after the file part of a large upload', async () => {
    // 回归：字段排在文件之后时，读到文件那一刻字段还没解析到，接口回答「请提供 minifiedFile」。
    // 请求一次到齐的小文件看不出来，所以这里经真实 HTTP 分块上传一份 3 MB 的 map（JSON 允许空白填充）。
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const form = new FormData();
    form.append(
      'file',
      new Blob([`${VALID_MAP.slice(0, -1)}${' '.repeat(3_000_000)}}`]),
      'app.aabbccdd.js.map',
    );
    form.append('minifiedFile', 'app.aabbccdd.js');
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/releases/demo-release-2-4-1/source-maps`,
      { method: 'POST', body: form },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ minifiedFile: 'app.aabbccdd.js' });
  });

  it('keeps accepting telemetry when a registered map file has been removed', async () => {
    expect((await uploadMap(VALID_MAP)).statusCode).toBe(201);
    for (const file of await readdir(join(directory, 'maps'))) {
      await unlink(join(directory, 'maps', file));
    }
    // 解析结果只在内存里；清空缓存相当于服务重启之后。
    clearSourceMapCache();

    const response = await ingest('after-missing-map');
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1 });
  });

  it('keeps accepting telemetry when a stored map turns out to be corrupt', async () => {
    // 完整校验之前存下的 map，或者磁盘上被改坏的文件，都可能在查询时才暴露问题。
    expect((await uploadMap(VALID_MAP)).statusCode).toBe(201);
    for (const file of await readdir(join(directory, 'maps'))) {
      await writeFile(join(directory, 'maps', file), VALID_MAP.replace('AAAA', 'AAAA;!!!!'));
    }
    clearSourceMapCache();

    const first = await ingest('with-corrupt-map');
    expect(first.statusCode).toBe(202);
    // SDK 的重试也不会再撞上 500：同一批按重复送达处理。
    const retry = await ingest('with-corrupt-map');
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('keeps the position of a stack frame whose URL carried a query string', async () => {
    // 回归：服务端脱敏曾把 "app.js?v=3:1:1)" 从问号起整段删掉，存下的堆栈没了行列号，
    // 之后上传 map 也无法回填。
    const stack = 'TypeError: x\n    at submit (https://shop.test/assets/app.aabbccdd.js?v=3:1:1)';
    expect((await ingest('query-frame', stack)).statusCode).toBe(202);
    expect((await uploadMap(VALID_MAP)).statusCode).toBe(201);
    expect(await originalStackOf('query-frame')).toContain('src/cart.ts:1:1');
  });

  it('does not symbolicate a retried batch again', async () => {
    expect((await uploadMap(VALID_MAP)).statusCode).toBe(201);
    const stack = 'TypeError: x\n    at submit (https://shop.test/assets/app.aabbccdd.js:1:1)';
    expect((await ingest('retried', stack)).statusCode).toBe(202);
    expect(await originalStackOf('retried')).toContain('src/cart.ts:1:1');

    // 清掉还原结果后重发同一批：重复送达的事件入库时已经还原过，不再重算。
    const sqlite = new Database(join(directory, 'test.db'));
    sqlite.prepare('UPDATE events SET original_stack = NULL').run();
    sqlite.close();
    expect((await ingest('retried', stack)).json()).toMatchObject({ duplicates: 1 });
    expect(await originalStackOf('retried')).toBeNull();
  });
});
