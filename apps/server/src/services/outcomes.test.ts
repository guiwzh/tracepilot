import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import { ingestStats, OutcomeRecorder } from './outcomes';

const HOUR = 3_600_000;
const NOW = 500_000 * HOUR + 30 * 60_000;

let directory: string;
let database: TraceDatabase;
let recorder: OutcomeRecorder;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-outcomes-'));
  database = createDatabase(join(directory, 'test.db'));
  ensureDemoProject(database);
  recorder = new OutcomeRecorder(database);
});

afterEach(async () => {
  recorder.close();
  database.close();
  await rm(directory, { recursive: true, force: true });
});

describe('ingest outcomes', () => {
  it('aggregates counts in memory and adds them to the hourly rows on each flush', () => {
    recorder.record('demo-project', 'accepted', 10, '', NOW);
    recorder.record('demo-project', 'accepted', 5, '', NOW + 60_000);
    recorder.record('demo-project', 'filtered', 2, 'web-crawler', NOW);
    // 写库之前什么都没有：计数在内存里合并，不是每个请求写一行。
    expect(database.sqlite.prepare('SELECT COUNT(*) AS n FROM ingest_outcomes').get()).toEqual({
      n: 0,
    });
    recorder.flush();
    recorder.record('demo-project', 'accepted', 1, '', NOW);
    recorder.record('demo-project', 'rate_limited', 100, 'spike-protection', NOW - HOUR);
    recorder.flush();

    const stats = ingestStats(database, 'demo-project', 3, NOW);
    expect(stats).toMatchObject({
      accepted: 16,
      filtered: { 'web-crawler': 2 },
      rateLimited: { 'spike-protection': 100 },
    });
    // 三个小时各一格，没有上报的小时是 0。
    expect(stats.hourly.map((slot) => [slot.accepted, slot.filtered, slot.rateLimited])).toEqual([
      [0, 0, 0],
      [0, 0, 100],
      [16, 2, 0],
    ]);
  });

  it('skips counts for a project that no longer exists instead of losing the whole batch', () => {
    recorder.record('gone', 'accepted', 3, '', NOW);
    recorder.record('demo-project', 'accepted', 4, '', NOW);
    recorder.flush();
    expect(ingestStats(database, 'demo-project', 1, NOW).accepted).toBe(4);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS n FROM ingest_outcomes').get()).toEqual({
      n: 1,
    });
  });
});
