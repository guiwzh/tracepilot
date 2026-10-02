import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvestigationRun, MonitorEvent } from '@trace-pilot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import type { AlertMessage } from './alertChannels';
import { createAlertRule, updateAlertRule } from './alerts';
import {
  AUTO_INVESTIGATION,
  enqueueFollowUp,
  followUpDetail,
  startAutoInvestigation,
  type InvestigationStarter,
} from './autoInvestigation';
import { ingestEnvelope } from './events';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR = 3_600_000;

let directory: string;
let database: TraceDatabase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-auto-'));
  database = createDatabase(join(directory, 'test.db'));
  ensureDemoProject(database);
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

async function newIssue(message: string): Promise<string> {
  const event: MonitorEvent = {
    eventId: randomUUID(),
    eventType: 'error',
    timestamp: NOW - 60_000,
    projectId: 'demo-project',
    release: '2.4.1',
    environment: 'production',
    page: { url: 'https://shop.test/checkout' },
    device: { userAgent: 'Chrome/130' },
    payload: { name: 'TypeError', message },
    breadcrumbs: [],
  };
  const { result } = await ingestEnvelope(
    database,
    { dsnKey: 'demo-dsn-key', sentAt: NOW, events: [event] },
    NOW,
  );
  return result.issueIds[0]!;
}

function addRun(issueId: string, startedBy: 'person' | 'alert', startedAt: number): string {
  const id = randomUUID();
  database.sqlite
    .prepare(
      `INSERT INTO investigation_runs (id, issue_id, status, engine, model, started_by, started_at)
       VALUES (?, ?, 'completed', 'local', 'local-scripted-investigator', ?, ?)`,
    )
    .run(id, issueId, startedBy, startedAt);
  return id;
}

/** 替身：每次发起都真的写一行运行记录，冷却和上限的判断才有数据可查。 */
function starter(dailyLimit = 3, busy = false): InvestigationStarter & { started: string[] } {
  const started: string[] = [];
  return {
    dailyLimit,
    started,
    start: (issueId) => {
      if (busy) return { skipped: 'busy' };
      started.push(issueId);
      return { runId: addRun(issueId, 'alert', NOW) };
    },
  };
}

describe('starting investigations from alerts', () => {
  it('starts one, then holds back for the cooldown, the daily limit, a busy service or a zero limit', async () => {
    const first = await newIssue('First failure');
    const second = await newIssue('Second failure');
    const third = await newIssue('Third failure');
    const limited = starter(2);

    const started = startAutoInvestigation(
      database,
      limited,
      { id: first, projectId: 'demo-project' },
      NOW,
    );
    expect(started).toMatchObject({ runId: expect.any(String) });
    // 同一个 Issue 24 小时内已经调查过（这次是告警发起的；人点的也一样）。
    expect(
      startAutoInvestigation(database, limited, { id: first, projectId: 'demo-project' }, NOW),
    ).toEqual({ note: 'cooldown' });
    expect(
      startAutoInvestigation(database, limited, { id: second, projectId: 'demo-project' }, NOW),
    ).toMatchObject({ runId: expect.any(String) });
    // 上限 2：第三个 Issue 等 24 小时滚动窗口过去。人点的调查不占上限。
    addRun(third, 'person', NOW - AUTO_INVESTIGATION.cooldownMs - 1);
    expect(
      startAutoInvestigation(database, limited, { id: third, projectId: 'demo-project' }, NOW),
    ).toEqual({ note: 'daily_limit' });
    expect(
      startAutoInvestigation(
        database,
        limited,
        { id: third, projectId: 'demo-project' },
        NOW + AUTO_INVESTIGATION.windowMs + 1,
      ),
    ).toMatchObject({ runId: expect.any(String) });

    expect(
      startAutoInvestigation(
        database,
        starter(5, true),
        { id: third, projectId: 'demo-project' },
        NOW + 3 * AUTO_INVESTIGATION.windowMs,
      ),
    ).toEqual({ note: 'busy' });
    expect(
      startAutoInvestigation(database, starter(0), { id: third, projectId: 'demo-project' }, NOW),
    ).toEqual({ note: 'disabled' });
  });
});

function run(overrides: Partial<InvestigationRun>): InvestigationRun {
  return {
    id: 'run-1',
    issueId: 'issue-1',
    status: 'completed',
    engine: 'model',
    model: 'deepseek-chat',
    startedBy: 'alert',
    startedAt: NOW,
    finishedAt: NOW + 8_000,
    usage: { inputTokens: 1, outputTokens: 1, steps: 1, toolCalls: 1 },
    report: {
      summary: 'calculateTotal reads cart.summary.total while summary is missing since 2.4.1.',
      evidence: [
        {
          resultRef: 'T1',
          toolCallId: 'a',
          quote: 'q',
          description: 'd',
          source: 'source',
          verified: true,
        },
        {
          resultRef: 'T2',
          toolCallId: 'b',
          quote: 'q',
          description: 'd',
          source: 'commit',
          verified: false,
        },
      ],
      possibleCauses: [
        { cause: 'A release stopped guarding summary.', confidence: 0.4, evidenceRefs: [1] },
        { cause: 'cart.summary is optional and unguarded.', confidence: 0.82, evidenceRefs: [0] },
      ],
      investigationSteps: [],
      suggestions: [],
      missingInformation: [],
      verification: { attempts: 1, allVerified: false, problems: [] },
      disclaimer: 'd',
    },
    error: null,
    ...overrides,
  } as InvestigationRun;
}

describe('follow-up notifications', () => {
  it('summarizes the report, the top cause and how many citations held up', () => {
    expect(followUpDetail(run({}))).toBe(
      [
        'calculateTotal reads cart.summary.total while summary is missing since 2.4.1.',
        'Top cause (confidence 0.82): cart.summary is optional and unguarded.',
        '1/2 citations verified against tool output.',
      ].join('\n'),
    );
    // 离线脚本跑的如实标注。
    expect(followUpDetail(run({ engine: 'local' }))).toContain('not model reasoning');
    expect(followUpDetail(run({ status: 'failed', report: null, error: 'STEP_LIMIT' }))).toContain(
      'stopped (STEP_LIMIT)',
    );
    expect(followUpDetail(run({ status: 'cancelled', report: null }))).toBe(
      'The investigation was cancelled.',
    );
  });

  it('queues the follow-up on the rule that started the investigation, unless it is gone or muted', async () => {
    const issueId = await newIssue('Checkout failed');
    const rule = createAlertRule(database, 'demo-project', {
      name: 'On call',
      triggers: ['new_issue'],
      minLevel: 'error',
      intervalMinutes: 60,
      autoInvestigate: true,
      channel: { type: 'webhook', url: 'http://127.0.0.1:9/hook' },
    });
    const runId = addRun(issueId, 'alert', NOW);
    const original: AlertMessage = {
      trigger: 'new_issue',
      project: { id: 'demo-project', name: 'Checkout Web' },
      issue: {
        id: issueId,
        title: 'Checkout failed',
        level: 'error',
        status: 'unresolved',
        eventCount: 1,
        userCount: 0,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        release: '2.4.1',
      },
      detail: 'First seen in release 2.4.1.',
      url: `http://localhost:4173/projects/demo-project/issues/${issueId}`,
    };
    database.sqlite
      .prepare(
        `INSERT INTO alert_deliveries (id, rule_id, project_id, issue_id, trigger_type, status, attempts,
           payload_json, investigation_id, created_at)
         VALUES ('origin', ?, 'demo-project', ?, 'new_issue', 'sent', 1, ?, ?, ?)`,
      )
      .run(rule.id, issueId, JSON.stringify(original), runId, NOW);

    expect(enqueueFollowUp(database, run({ id: runId, issueId }), NOW + 10_000)).toBe(true);
    const followUp = database.sqlite
      .prepare(
        "SELECT status, payload_json FROM alert_deliveries WHERE trigger_type = 'investigation'",
      )
      .get() as { status: string; payload_json: string };
    expect(followUp.status).toBe('pending');
    expect(JSON.parse(followUp.payload_json)).toMatchObject({
      trigger: 'investigation',
      investigation: {
        id: runId,
        status: 'completed',
        url: `http://localhost:4173/projects/demo-project/issues/${issueId}?tab=investigation`,
      },
    });

    updateAlertRule(database, rule.id, { mutedUntil: NOW + HOUR });
    expect(enqueueFollowUp(database, run({ id: runId, issueId }), NOW + 20_000)).toBe(false);
    updateAlertRule(database, rule.id, { enabled: false, mutedUntil: null });
    expect(enqueueFollowUp(database, run({ id: runId, issueId }), NOW + 30_000)).toBe(false);
    expect(enqueueFollowUp(database, run({ id: 'unknown-run', issueId }), NOW)).toBe(false);
    const statuses = database.sqlite
      .prepare(
        "SELECT status, reason FROM alert_deliveries WHERE trigger_type = 'investigation' ORDER BY created_at",
      )
      .all();
    expect(statuses).toEqual([
      { status: 'pending', reason: null },
      { status: 'suppressed', reason: 'muted' },
    ]);
  });
});
