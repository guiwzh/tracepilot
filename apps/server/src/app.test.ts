import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { buildApp } from './app';
import type { ServerConfig } from './config';

let directory: string;
let app: Awaited<ReturnType<typeof buildApp>>;

function event(id: string, dynamicId: string): MonitorEvent {
  return {
    eventId: id,
    eventType: 'error',
    timestamp: Date.now(),
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
    const response = await app.inject({ method: 'POST', url: '/api/v1/envelopes', payload: { events: [] } });
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
    expect(metrics.json().items.find((item: { metric: string }) => item.metric === 'LCP')).toMatchObject({
      p75: 2100,
      samples: 1,
    });
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
