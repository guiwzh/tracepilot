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
import { eventFingerprint, normalizeDisplayTitle } from '../lib/fingerprint';

/**
 * 接入服务是遥测写入的事务边界：鉴权、幂等、脱敏、Release 关联、
 * Issue 聚合和事件落库要么一起成功，要么整批回滚。
 */
export interface IngestResult {
  accepted: number;
  duplicates: number;
  /** 以同一个 metricId 再次上报、覆盖了旧值的 Web Vitals 样本数。 */
  metricUpdates: number;
  issueIds: string[];
}

/**
 * web-vitals 为每个页面加载中的每个指标分配唯一 id；LCP/CLS/INP 的值在页面生命周期里会增长，
 * SDK 会以同一个 id 再报一次。按 id 覆盖而不是追加，否则同一次访问的多个中间值会把 p75 拉偏。
 */
function metricInstanceId(event: MonitorEvent): string | null {
  if (event.eventType !== 'performance') return null;
  const metricId = event.payload.metricId;
  return typeof metricId === 'string' && metricId.length > 0 && metricId.length <= 200
    ? metricId
    : null;
}

function eventContext(event: MonitorEvent) {
  return {
    page: { ...event.page, url: stripUrlQuery(event.page.url) },
    device: event.device,
    payload: event.payload,
    environment: event.environment,
    release: event.release,
  };
}

function shouldCreateIssue(event: MonitorEvent): boolean {
  // 性能样本只进入指标流；成功网络请求只做证据，失败请求才需要形成 Issue。
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
  return normalizeDisplayTitle(
    String(payload.message ?? payload.name ?? 'Unknown client error').slice(0, 500),
  );
}

function eventLevel(event: MonitorEvent): 'error' | 'warning' | 'info' {
  const declared = event.payload.level;
  if (declared === 'warning' || declared === 'info' || declared === 'error') return declared;
  if (event.eventType === 'performance') return 'info';
  if (event.eventType === 'network' && Number(event.payload.status ?? 0) < 500) return 'warning';
  return 'error';
}

function ensureRelease(database: TraceDatabase, event: MonitorEvent): string {
  // SDK 可能先于人工创建 Release 上线，因此接入时按版本号惰性补建记录。
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
  // 指纹是聚合键；同项目相同指纹复用 Issue，只更新出现时间和最新标题。
  const fingerprint = eventFingerprint(event);
  const existing = database.sqlite
    .prepare(
      'SELECT id, first_seen_at, last_seen_at FROM issues WHERE project_id = ? AND fingerprint = ?',
    )
    .get(event.projectId, fingerprint) as
    { id: string; first_seen_at: number; last_seen_at: number } | undefined;

  if (existing) {
    database.db
      .update(issues)
      .set({
        firstSeenAt: Math.min(existing.first_seen_at, event.timestamp),
        lastSeenAt: Math.max(existing.last_seen_at, event.timestamp),
        ...(event.timestamp >= existing.last_seen_at ? { title: eventTitle(event) } : {}),
      })
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
      // 两个计数都从 0 起步，统一由 updateIssueCounters 在事件落库后增量累加，
      // 避免新建 Issue 的首条事件被同时计入初始值和增量而重复计数。
      eventCount: 0,
      userCount: 0,
    })
    .run();
  return id;
}

function isFirstEventForUser(
  database: TraceDatabase,
  issueId: string,
  userId: string | null,
): boolean {
  // 必须在插入本条事件之前判定，否则永远会查到刚写入的这一行，user_count 将恒为 0。
  // 查询走 (issue_id, user_id) 索引，代价与 Issue 已有事件数无关。
  if (userId === null) return false;
  return !database.sqlite
    .prepare('SELECT 1 FROM events WHERE issue_id = ? AND user_id = ? LIMIT 1')
    .get(issueId, userId);
}

function updateIssueCounters(
  database: TraceDatabase,
  issueId: string,
  firstSeenForUser: boolean,
): void {
  // 幂等已由前置的 eventId 去重保证（重复批次在插入前就 continue 了），因此这里增量 +1。
  // 早期实现每条事件都用 COUNT(*) 重新派生计数，单次写入退化为 O(Issue 内事件数)，
  // 单 Issue 累积到一万条时单批接入 P50 从 1.79 ms 劣化到 12.88 ms。
  database.sqlite
    .prepare(
      'UPDATE issues SET event_count = event_count + 1, user_count = user_count + ? WHERE id = ?',
    )
    .run(firstSeenForUser ? 1 : 0, issueId);
}

export function ingestEnvelope(database: TraceDatabase, envelope: EventEnvelope): IngestResult {
  // 先用公开 DSN Key 找项目；后面还会校验每个事件声明的 projectId。
  const project = database.sqlite
    .prepare('SELECT id FROM projects WHERE dsn_key = ?')
    .get(envelope.dsnKey) as { id: string } | undefined;
  if (!project) throw new Error('INVALID_DSN');

  let accepted = 0;
  let duplicates = 0;
  let metricUpdates = 0;
  const issueIds = new Set<string>();

  // better-sqlite3 transaction 接受同步回调，回调抛错时会自动 ROLLBACK。
  const ingest = database.sqlite.transaction(() => {
    for (const rawEvent of envelope.events) {
      if (rawEvent.projectId !== project.id) throw new Error('PROJECT_DSN_MISMATCH');
      const metricId = metricInstanceId(rawEvent);
      // 指标样本的行 id 由 metricId 派生，普通事件沿用 SDK 生成的 eventId。
      const rowId = metricId ? `metric:${project.id}:${metricId}` : rawEvent.eventId;
      const existing = database.sqlite
        .prepare('SELECT created_at FROM events WHERE id = ?')
        .get(rowId) as { created_at: number } | undefined;
      if (existing && metricId) {
        // 以采集时间为准做「后写者胜」：重试或补发的旧值晚到时，不能覆盖已经入库的新值。
        if (rawEvent.timestamp >= existing.created_at) {
          database.sqlite
            .prepare('UPDATE events SET context_json = ?, created_at = ? WHERE id = ?')
            .run(
              JSON.stringify(eventContext(redactSensitive(rawEvent))),
              rawEvent.timestamp,
              rowId,
            );
        }
        metricUpdates += 1;
        continue;
      }
      if (existing) {
        // eventId 是幂等键，浏览器重试同一批次、或 beacon 与在途请求重复送达时不会重复写入。
        duplicates += 1;
        continue;
      }

      // 即使 SDK 已运行 beforeSend，Server 仍把客户端数据视为不可信并二次脱敏。
      const event = redactSensitive(rawEvent);
      const releaseId = ensureRelease(database, event);
      const issueId = upsertIssue(database, event);
      const message = eventTitle(event);
      const stack = typeof event.payload.stack === 'string' ? event.payload.stack : null;
      const userId = event.user?.id ?? event.user?.anonymousId ?? null;
      const context = eventContext(event);

      // 必须在事件落库之前判定，否则会查到本条刚写入的记录。
      const firstSeenForUser = issueId ? isFirstEventForUser(database, issueId, userId) : false;

      database.db
        .insert(events)
        .values({
          id: rowId,
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
        updateIssueCounters(database, issueId, firstSeenForUser);
        issueIds.add(issueId);
      }
      accepted += 1;
    }
  });
  ingest();
  return { accepted, duplicates, metricUpdates, issueIds: [...issueIds] };
}
