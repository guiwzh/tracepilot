import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MonitorEvent } from '@trace-pilot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import { IngestError, ingestEnvelope } from './events';

let directory: string;
let database: TraceDatabase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-ingest-'));
  database = createDatabase(join(directory, 'test.db'));
  ensureDemoProject(database);
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

const RECEIVED_AT = Date.UTC(2026, 8, 28, 12, 0, 0);
const HOUR = 3_600_000;

function errorAt(id: string, timestamp: number): MonitorEvent {
  return {
    eventId: id,
    eventType: 'error',
    timestamp,
    projectId: 'demo-project',
    release: '2.4.1',
    environment: 'production',
    page: { url: 'https://shop.test/checkout' },
    device: { userAgent: 'Chrome/130' },
    payload: { name: 'TypeError', message: `failure ${id}` },
    breadcrumbs: [
      {
        id: `${id}-click`,
        type: 'click',
        category: 'ui',
        message: 'Pay',
        timestamp: timestamp - 3_000,
      },
    ],
  };
}

function stored(id: string) {
  const row = database.sqlite
    .prepare('SELECT created_at, breadcrumbs_json FROM events WHERE id = ?')
    .get(id) as { created_at: number; breadcrumbs_json: string };
  const [click] = JSON.parse(row.breadcrumbs_json) as Array<{ timestamp: number }>;
  return { createdAt: row.created_at, clickBefore: row.created_at - click!.timestamp };
}

describe('event time', () => {
  it('moves events from a device whose clock is a year ahead onto the server clock', () => {
    const skew = 365 * 24 * HOUR;
    const sentAt = RECEIVED_AT + skew;
    ingestEnvelope(
      database,
      { dsnKey: 'demo-dsn-key', sentAt, events: [errorAt('ahead', sentAt - 5_000)] },
      RECEIVED_AT,
    );
    // 发生在发送前 5 秒；点击仍在错误之前 3 秒。
    expect(stored('ahead')).toEqual({ createdAt: RECEIVED_AT - 5_000, clickBefore: 3_000 });
    const issue = database.sqlite.prepare('SELECT last_seen_at FROM issues').get();
    expect(issue).toEqual({ last_seen_at: RECEIVED_AT - 5_000 });
  });

  it('uses the receive time for an event dated in the future of its own envelope', () => {
    ingestEnvelope(
      database,
      {
        dsnKey: 'demo-dsn-key',
        sentAt: RECEIVED_AT,
        events: [errorAt('future', RECEIVED_AT + 2 * HOUR)],
      },
      RECEIVED_AT,
    );
    expect(stored('future')).toEqual({ createdAt: RECEIVED_AT, clickBefore: 3_000 });
  });

  it('leaves the time of a device with an accurate clock alone', () => {
    // 几秒的网络耗时不是时钟偏差；重试后才送达的旧事件本来就发生在过去。
    ingestEnvelope(
      database,
      {
        dsnKey: 'demo-dsn-key',
        sentAt: RECEIVED_AT - 4_000,
        events: [errorAt('now', RECEIVED_AT - 4_500), errorAt('replayed', RECEIVED_AT - 48 * HOUR)],
      },
      RECEIVED_AT,
    );
    expect(stored('now').createdAt).toBe(RECEIVED_AT - 4_500);
    expect(stored('replayed').createdAt).toBe(RECEIVED_AT - 48 * HOUR);
  });

  it('rejects envelopes whose DSN does not match with a typed error', () => {
    expect(() =>
      ingestEnvelope(database, {
        dsnKey: 'unknown',
        sentAt: RECEIVED_AT,
        events: [errorAt('a', 1)],
      }),
    ).toThrow(IngestError);
    expect(() =>
      ingestEnvelope(database, {
        dsnKey: 'demo-dsn-key',
        sentAt: RECEIVED_AT,
        events: [{ ...errorAt('b', RECEIVED_AT), projectId: 'other-project' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'PROJECT_DSN_MISMATCH' }));
  });
});

describe('failed request grouping', () => {
  it('keeps each method and status on a URL as its own issue with its own level', () => {
    const failed = (id: string, method: string, status: number): MonitorEvent => ({
      ...errorAt(id, RECEIVED_AT),
      eventType: 'network',
      payload: { method, url: 'https://api.shop.test/cart', status, duration: 12, success: false },
    });
    ingestEnvelope(
      database,
      {
        dsnKey: 'demo-dsn-key',
        sentAt: RECEIVED_AT,
        events: [failed('a', 'GET', 404), failed('b', 'POST', 503), failed('c', 'POST', 503)],
      },
      RECEIVED_AT,
    );
    const issues = database.sqlite
      .prepare('SELECT title, level, event_count FROM issues ORDER BY title')
      .all();
    expect(issues).toEqual([
      { title: 'GET https://api.shop.test/cart → 404', level: 'warning', event_count: 1 },
      { title: 'POST https://api.shop.test/cart → 503', level: 'error', event_count: 2 },
    ]);
  });
});

describe('sample rate', () => {
  it('keeps the rate an event was sampled at, treating older SDKs as full samples', () => {
    ingestEnvelope(
      database,
      {
        dsnKey: 'demo-dsn-key',
        sentAt: RECEIVED_AT,
        events: [
          { ...errorAt('sampled', RECEIVED_AT), sampleRate: 0.25 },
          errorAt('legacy', RECEIVED_AT),
        ],
      },
      RECEIVED_AT,
    );
    const rate = (id: string) =>
      JSON.parse(
        (
          database.sqlite.prepare('SELECT context_json FROM events WHERE id = ?').get(id) as {
            context_json: string;
          }
        ).context_json,
      ).sampleRate;
    expect([rate('sampled'), rate('legacy')]).toEqual([0.25, 1]);
  });
});

describe('business errors', () => {
  it('groups a 200 response with a failing business code by that code', () => {
    const business = (id: string, code: number): MonitorEvent => ({
      ...errorAt(id, RECEIVED_AT),
      eventType: 'network',
      payload: {
        method: 'POST',
        url: 'https://api.shop.test/coupon',
        status: 200,
        duration: 12,
        success: false,
        businessCode: code,
        businessMessage: 'Coupon expired',
      },
    });
    ingestEnvelope(
      database,
      {
        dsnKey: 'demo-dsn-key',
        sentAt: RECEIVED_AT,
        events: [business('a', 40012), business('b', 40012), business('c', 50001)],
      },
      RECEIVED_AT,
    );
    const issues = database.sqlite
      .prepare('SELECT title, level, event_count FROM issues ORDER BY title')
      .all();
    expect(issues).toEqual([
      { title: 'POST https://api.shop.test/coupon → code 40012', level: 'error', event_count: 2 },
      { title: 'POST https://api.shop.test/coupon → code 50001', level: 'error', event_count: 1 },
    ]);
  });
});
