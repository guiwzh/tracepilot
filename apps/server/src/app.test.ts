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
