import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MonitorEvent } from '@trace-pilot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import { createAlertRule } from './alerts';
import { ESCALATION, EscalationDetector, escalationThreshold } from './escalation';
import { ingestEnvelope } from './events';
import { listActivity, setIssueStatus } from './lifecycle';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

let directory: string;
let database: TraceDatabase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-lifecycle-'));
  database = createDatabase(join(directory, 'test.db'));
  ensureDemoProject(database);
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function failure(id: string, timestamp: number, message = 'Checkout failed'): MonitorEvent {
  return {
    eventId: id,
    eventType: 'error',
    timestamp,
    projectId: 'demo-project',
    release: '2.4.1',
    environment: 'production',
    page: { url: 'https://shop.test/checkout' },
    device: { userAgent: 'Chrome/130' },
    payload: { name: 'TypeError', message },
    breadcrumbs: [],
  };
}

async function ingest(events: MonitorEvent[], receivedAt: number) {
  return ingestEnvelope(
    database,
    { dsnKey: 'demo-dsn-key', sentAt: receivedAt, events },
    receivedAt,
  );
}

function issue(issueId: string) {
  return database.sqlite
    .prepare('SELECT status, substatus, substatus_at FROM issues WHERE id = ?')
    .get(issueId) as { status: string; substatus: string | null; substatus_at: number | null };
}

/** 直接写入事件行：恶化检测只数事件，造几千个事件不必走完整的接入。 */
function addEvents(issueId: string, timestamps: number[]): void {
  const insert = database.sqlite.prepare(
    `INSERT INTO events (id, issue_id, type, message, page_url, context_json, breadcrumbs_json, created_at)
     VALUES (?, ?, 'error', 'Checkout failed', 'https://shop.test/checkout', '{}', '[]', ?)`,
  );
  database.sqlite.transaction(() => {
    timestamps.forEach((at, index) => insert.run(`${issueId}-${at}-${index}`, issueId, at));
  })();
}

/** n 个事件，均匀分布在 [from, to) 之间。 */
function spread(n: number, from: number, to: number): number[] {
  return Array.from({ length: n }, (_, index) => from + Math.floor(((to - from) * index) / n));
}

describe('issue lifecycle', () => {
  it('records creation and regression in the ingest transaction, but not late events', async () => {
    // 只订阅回归：新建的记录写入时就已处理，回归的那条等待告警。
    createAlertRule(database, 'demo-project', {
      name: 'Regressions',
      triggers: ['regression'],
      minLevel: 'error',
      intervalMinutes: 60,
      channel: { type: 'webhook', url: 'http://127.0.0.1:9/hook' },
    });
    const { result, alertsQueued: queuedOnCreate } = await ingest(
      [failure('a', NOW - HOUR)],
      NOW - HOUR,
    );
    expect(queuedOnCreate).toBe(0);
    const issueId = result.issueIds[0]!;
    expect(listActivity(database, issueId).map((item) => item.kind)).toEqual(['created']);

    setIssueStatus(database, issueId, 'resolved', false, NOW - 30 * 60_000);
    // 解决之前就发生、只是迟到的事件：不是回归。
    await ingest([failure('late', NOW - 40 * 60_000)], NOW - 20 * 60_000);
    expect(issue(issueId)).toMatchObject({ status: 'resolved', substatus: null });

    const { alertsQueued } = await ingest([failure('b', NOW - 60_000)], NOW);
    expect(alertsQueued).toBe(1);
    expect(issue(issueId)).toEqual({
      status: 'unresolved',
      substatus: 'regressed',
      substatus_at: NOW,
    });
    const activity = listActivity(database, issueId);
    expect(activity.map((item) => item.kind)).toEqual(['regressed', 'status_changed', 'created']);
    expect(activity[0]!.data).toMatchObject({ release: '2.4.1' });

    // 只有被规则订阅的新建、回归、恶化等待告警；状态变更只是时间线上的记录。
    const pending = database.sqlite
      .prepare('SELECT kind FROM issue_activity WHERE processed = 0 ORDER BY id')
      .all();
    expect(pending).toEqual([{ kind: 'regressed' }]);
  });

  it('clears the substatus when a person changes the status, and remembers ignore-until-escalating', async () => {
    const { result } = await ingest([failure('a', NOW - HOUR)], NOW - HOUR);
    const issueId = result.issueIds[0]!;
    database.sqlite
      .prepare("UPDATE issues SET substatus = 'regressed', substatus_at = ? WHERE id = ?")
      .run(NOW - HOUR, issueId);

    expect(setIssueStatus(database, issueId, 'ignored', true, NOW)).toEqual({
      id: issueId,
      status: 'ignored',
      substatus: 'until_escalating',
    });
    expect(listActivity(database, issueId)[0]).toMatchObject({
      kind: 'status_changed',
      data: {
        from: 'unresolved',
        to: 'ignored',
        fromSubstatus: 'regressed',
        substatus: 'until_escalating',
      },
    });
    // untilEscalating 只对 ignored 有意义。
    expect(setIssueStatus(database, issueId, 'unresolved', true, NOW)?.substatus).toBeNull();
    expect(setIssueStatus(database, 'missing', 'resolved')).toBeNull();
  });
});

describe('escalation', () => {
  it('uses five times the usual hourly volume, with a floor of twenty events', () => {
    expect(escalationThreshold(0, 48)).toBe(ESCALATION.floor);
    expect(escalationThreshold(48, 48)).toBe(20);
    expect(escalationThreshold(48 * 30, 48)).toBe(150);
    expect(escalationThreshold(10, 0)).toBe(20);
  });

  async function issueSeenFor(hours: number): Promise<string> {
    const { result } = await ingest([failure('first', NOW - hours * HOUR)], NOW - hours * HOUR);
    return result.issueIds[0]!;
  }

  it('escalates an issue once when the last hour runs far above its own baseline', async () => {
    const issueId = await issueSeenFor(48);
    // 两天里每小时约 1 个，最近一小时 30 个：阈值是 max(20, 5 × 1) = 20。
    addEvents(issueId, spread(47, NOW - 48 * HOUR + 1, NOW - HOUR));
    addEvents(issueId, spread(30, NOW - HOUR + 1, NOW));

    const detector = new EscalationDetector(database);
    expect(detector.check([issueId], NOW)).toEqual([issueId]);
    expect(issue(issueId)).toMatchObject({ status: 'unresolved', substatus: 'escalating' });
    expect(listActivity(database, issueId)[0]).toMatchObject({
      kind: 'escalating',
      // 基线：首个事件加 47 个，共 48 个，分布在最近一小时之前的 47 小时里。
      data: { recentEvents: 30, threshold: 20, baselinePerHour: 1.02 },
    });

    // 一分钟内不再检查；之后它已经是恶化状态，不重复触发。
    expect(detector.check([issueId], NOW + 30_000)).toEqual([]);
    addEvents(issueId, spread(30, NOW, NOW + 2 * 60_000));
    expect(detector.check([issueId], NOW + 2 * 60_000)).toEqual([]);
    expect(
      listActivity(database, issueId).filter((item) => item.kind === 'escalating'),
    ).toHaveLength(1);
  });

  it('judges a busy issue against its own normal, not a global number', async () => {
    const issueId = await issueSeenFor(26);
    // 常态每小时 20 个，最近一小时 60 个：是常态的 3 倍，不到 5 倍（阈值 100）。
    addEvents(issueId, spread(25 * 20, NOW - 26 * HOUR + 1, NOW - HOUR));
    addEvents(issueId, spread(60, NOW - HOUR + 1, NOW));
    const detector = new EscalationDetector(database);
    expect(detector.check([issueId], NOW)).toEqual([]);

    addEvents(issueId, spread(60, NOW - 30 * 60_000, NOW));
    expect(detector.check([issueId], NOW + ESCALATION.checkIntervalMs)).toEqual([issueId]);
  });

  it('reopens an issue ignored until escalating, but leaves ignored-forever and young issues alone', async () => {
    const detector = new EscalationDetector(database);
    const untilEscalating = await issueSeenFor(48);
    setIssueStatus(database, untilEscalating, 'ignored', true, NOW - 2 * HOUR);
    addEvents(untilEscalating, spread(40, NOW - HOUR + 1, NOW));
    expect(detector.check([untilEscalating], NOW)).toEqual([untilEscalating]);
    expect(issue(untilEscalating)).toMatchObject({ status: 'unresolved', substatus: 'escalating' });
    expect(listActivity(database, untilEscalating)[0]?.data).toMatchObject({ reopened: true });

    const { result } = await ingest(
      [failure('forever', NOW - 48 * HOUR, 'Other failure')],
      NOW - 48 * HOUR,
    );
    const forever = result.issueIds[0]!;
    setIssueStatus(database, forever, 'ignored', false, NOW - 2 * HOUR);
    addEvents(forever, spread(40, NOW - HOUR + 1, NOW));
    expect(detector.check([forever], NOW)).toEqual([]);

    // 出现不到一天：没有基线可比，它已经有「新 Issue」告警了。
    const young = await ingest([failure('young', NOW - 3 * HOUR, 'Young failure')], NOW - 3 * HOUR);
    addEvents(young.result.issueIds[0]!, spread(200, NOW - HOUR + 1, NOW));
    expect(detector.check(young.result.issueIds, NOW)).toEqual([]);
  });
});
