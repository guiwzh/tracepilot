import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  redactSensitive,
  stripUrlQuery,
  type EventEnvelope,
  type MonitorEvent,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { events, issues, releases } from '../db/schema';
import { eventFingerprint } from '../lib/fingerprint';

export interface IngestResult {
  accepted: number;
  duplicates: number;
  issueIds: string[];
}

function shouldCreateIssue(event: MonitorEvent): boolean {
  if (event.eventType === 'performance') return false;
  if (event.eventType === 'network') {
    const status = Number(event.payload.status ?? 0);
    return event.payload.success === false || status >= 400 || Boolean(event.payload.error);
  }
  return true;
}

function eventTitle(event: MonitorEvent): string {
  const payload = event.payload;
  if (event.eventType === 'network') {
    return `${String(payload.method ?? 'GET').toUpperCase()} ${stripUrlQuery(String(payload.url ?? 'request'))} → ${String(payload.status ?? 'failed')}`;
  }
  if (event.eventType === 'resource') {
    return `Resource failed: ${stripUrlQuery(String(payload.url ?? payload.tagName ?? 'unknown'))}`;
  }
  if (event.eventType === 'performance') return `${String(payload.metric ?? 'Metric')} sample`;
  return String(payload.message ?? payload.name ?? 'Unknown client error').slice(0, 500);
}

function eventLevel(event: MonitorEvent): 'error' | 'warning' | 'info' {
  const declared = event.payload.level;
  if (declared === 'warning' || declared === 'info' || declared === 'error') return declared;
  if (event.eventType === 'performance') return 'info';
  if (event.eventType === 'network' && Number(event.payload.status ?? 0) < 500) return 'warning';
  return 'error';
}

function ensureRelease(database: TraceDatabase, event: MonitorEvent): string {
  const existing = database.sqlite
    .prepare('SELECT id FROM releases WHERE project_id = ? AND version = ?')
    .get(event.projectId, event.release) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  database.db
    .insert(releases)
    .values({ id, projectId: event.projectId, version: event.release, createdAt: event.timestamp })
    .run();
  return id;
}

function upsertIssue(database: TraceDatabase, event: MonitorEvent): string | null {
  if (!shouldCreateIssue(event)) return null;
  const fingerprint = eventFingerprint(event);
  const existing = database.sqlite
    .prepare('SELECT id FROM issues WHERE project_id = ? AND fingerprint = ?')
    .get(event.projectId, fingerprint) as { id: string } | undefined;
  const userId = event.user?.id ?? event.user?.anonymousId;

  if (existing) {
    database.db
      .update(issues)
      .set({ lastSeenAt: event.timestamp, title: eventTitle(event) })
      .where(eq(issues.id, existing.id))
      .run();
    return existing.id;
  }

  const id = randomUUID();
  database.db
    .insert(issues)
    .values({
      id,
      projectId: event.projectId,
      fingerprint,
      title: eventTitle(event),
      status: 'unresolved',
      level: eventLevel(event),
      firstSeenAt: event.timestamp,
      lastSeenAt: event.timestamp,
      eventCount: 0,
      userCount: userId ? 1 : 0,
    })
    .run();
  return id;
}

function updateIssueCounters(database: TraceDatabase, issueId: string): void {
  database.sqlite
    .prepare(
      `UPDATE issues SET
        event_count = (SELECT COUNT(*) FROM events WHERE issue_id = ?),
        user_count = (SELECT COUNT(DISTINCT user_id) FROM events WHERE issue_id = ? AND user_id IS NOT NULL)
       WHERE id = ?`,
    )
    .run(issueId, issueId, issueId);
}

export function ingestEnvelope(database: TraceDatabase, envelope: EventEnvelope): IngestResult {
  const project = database.sqlite
    .prepare('SELECT id FROM projects WHERE dsn_key = ?')
    .get(envelope.dsnKey) as { id: string } | undefined;
  if (!project) throw new Error('INVALID_DSN');

  let accepted = 0;
  let duplicates = 0;
  const issueIds = new Set<string>();

  const ingest = database.sqlite.transaction(() => {
    for (const rawEvent of envelope.events) {
      if (rawEvent.projectId !== project.id) throw new Error('PROJECT_DSN_MISMATCH');
      const duplicate = database.sqlite.prepare('SELECT 1 FROM events WHERE id = ?').get(rawEvent.eventId);
      if (duplicate) {
        duplicates += 1;
        continue;
      }

      const event = redactSensitive(rawEvent);
      const releaseId = ensureRelease(database, event);
      const issueId = upsertIssue(database, event);
      const message = eventTitle(event);
      const stack = typeof event.payload.stack === 'string' ? event.payload.stack : null;
      const userId = event.user?.id ?? event.user?.anonymousId ?? null;
      const context = {
        page: { ...event.page, url: stripUrlQuery(event.page.url) },
        device: event.device,
        payload: event.payload,
        environment: event.environment,
        release: event.release,
      };

      database.db
        .insert(events)
        .values({
          id: event.eventId,
          issueId,
          releaseId,
          type: event.eventType,
          message,
          stack,
          pageUrl: stripUrlQuery(event.page.url),
          userId,
          contextJson: JSON.stringify(context),
          breadcrumbsJson: JSON.stringify(event.breadcrumbs),
          createdAt: event.timestamp,
        })
        .run();
      if (issueId) {
        updateIssueCounters(database, issueId);
        issueIds.add(issueId);
      }
      accepted += 1;
    }
  });
  ingest();
  return { accepted, duplicates, issueIds: [...issueIds] };
}
