import {
  WEB_VITAL_THRESHOLDS,
  type Breadcrumb,
  type Issue,
  type IssueDetail,
  type IssueListResponse,
  type PerformanceMetric,
  type Project,
  type ProjectOverview,
  type Release,
  type StoredEvent,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson, percentile } from '../lib/json';

type Row = Record<string, unknown>;

function number(value: unknown): number {
  return Number(value ?? 0);
}

function mapIssue(row: Row): Issue {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    fingerprint: String(row.fingerprint),
    title: String(row.title),
    status: row.status as Issue['status'],
    level: row.level as Issue['level'],
    firstSeenAt: number(row.first_seen_at),
    lastSeenAt: number(row.last_seen_at),
    eventCount: number(row.event_count),
    userCount: number(row.user_count),
    latestRelease: row.latest_release ? String(row.latest_release) : null,
    trend: typeof row.trend === 'string' ? parseJson<number[]>(row.trend, []) : undefined,
  };
}

function mapEvent(row: Row): StoredEvent {
  return {
    id: String(row.id),
    issueId: row.issue_id ? String(row.issue_id) : null,
    releaseId: row.release_id ? String(row.release_id) : null,
    type: row.type as StoredEvent['type'],
    message: String(row.message),
    stack: row.stack ? String(row.stack) : null,
    originalStack: row.original_stack ? String(row.original_stack) : null,
    pageUrl: String(row.page_url),
    userId: row.user_id ? String(row.user_id) : null,
    context: parseJson<StoredEvent['context']>(String(row.context_json), {
      page: { url: String(row.page_url) },
      device: { userAgent: 'unknown' },
      payload: {},
      environment: 'unknown',
      release: 'unknown',
    }),
    breadcrumbs: parseJson<Breadcrumb[]>(String(row.breadcrumbs_json), []),
    createdAt: number(row.created_at),
  };
}

export function listProjects(database: TraceDatabase): Project[] {
  const rows = database.sqlite
    .prepare(
      `SELECT p.*,
        COUNT(DISTINCT i.id) AS issue_count,
        COUNT(DISTINCT e.id) AS event_count
       FROM projects p
       LEFT JOIN issues i ON i.project_id = p.id
       LEFT JOIN events e ON e.issue_id = i.id
       GROUP BY p.id ORDER BY p.created_at DESC`,
    )
    .all() as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    dsnKey: String(row.dsn_key),
    createdAt: number(row.created_at),
    issueCount: number(row.issue_count),
    eventCount: number(row.event_count),
  }));
}

export function listReleases(database: TraceDatabase, projectId: string): Release[] {
  const rows = database.sqlite
    .prepare(
      `SELECT r.*, COUNT(sm.id) AS source_map_count
       FROM releases r LEFT JOIN source_maps sm ON sm.release_id = r.id
       WHERE r.project_id = ? GROUP BY r.id ORDER BY r.created_at DESC`,
    )
    .all(projectId) as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    version: String(row.version),
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    createdAt: number(row.created_at),
    sourceMapCount: number(row.source_map_count),
  }));
}

export interface IssueFilters {
  page: number;
  pageSize: number;
  status?: string;
  level?: string;
  release?: string;
  browser?: string;
  route?: string;
  search?: string;
  sort?: string;
  order?: string;
  from?: number;
  to?: number;
}

export function listIssues(
  database: TraceDatabase,
  projectId: string,
  filters: IssueFilters,
): IssueListResponse {
  const conditions = ['i.project_id = ?'];
  const params: unknown[] = [projectId];
  if (filters.status && filters.status !== 'all') {
    conditions.push('i.status = ?');
    params.push(filters.status);
  }
  if (filters.level && filters.level !== 'all') {
    conditions.push('i.level = ?');
    params.push(filters.level);
  }
  if (filters.release) {
    conditions.push('EXISTS (SELECT 1 FROM events er JOIN releases rr ON rr.id = er.release_id WHERE er.issue_id = i.id AND rr.version = ?)');
    params.push(filters.release);
  }
  if (filters.browser) {
    conditions.push("EXISTS (SELECT 1 FROM events eb WHERE eb.issue_id = i.id AND json_extract(eb.context_json, '$.device.userAgent') LIKE ?)");
    params.push(`%${filters.browser}%`);
  }
  if (filters.route) {
    conditions.push('EXISTS (SELECT 1 FROM events ep WHERE ep.issue_id = i.id AND ep.page_url LIKE ?)');
    params.push(`%${filters.route}%`);
  }
  if (filters.search) {
    conditions.push('(i.title LIKE ? OR i.fingerprint LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.from) {
    conditions.push('i.last_seen_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('i.last_seen_at <= ?');
    params.push(filters.to);
  }
  const where = conditions.join(' AND ');
  const total = number(
    (database.sqlite.prepare(`SELECT COUNT(*) AS count FROM issues i WHERE ${where}`).get(...params) as Row)
      .count,
  );
  const sortColumns: Record<string, string> = {
    lastSeen: 'i.last_seen_at',
    firstSeen: 'i.first_seen_at',
    events: 'i.event_count',
    users: 'i.user_count',
  };
  const sort = sortColumns[filters.sort ?? 'lastSeen'] ?? 'i.last_seen_at';
  const order = filters.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (filters.page - 1) * filters.pageSize;
  const rows = database.sqlite
    .prepare(
      `SELECT i.*,
        (SELECT r.version FROM events e JOIN releases r ON r.id = e.release_id
         WHERE e.issue_id = i.id ORDER BY e.created_at DESC LIMIT 1) AS latest_release
       FROM issues i WHERE ${where}
       ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.pageSize, offset) as Row[];

  for (const row of rows) {
    const since = Date.now() - 6 * 60 * 60 * 1000;
    const points = database.sqlite
      .prepare(
        `SELECT CAST((created_at - ?) / 3600000 AS INTEGER) AS bucket, COUNT(*) AS count
         FROM events WHERE issue_id = ? AND created_at >= ? GROUP BY bucket`,
      )
      .all(since, row.id, since) as Row[];
    const trend = Array.from({ length: 7 }, () => 0);
    for (const point of points) {
      const bucket = Math.max(0, Math.min(6, number(point.bucket)));
      trend[bucket] = number(point.count);
    }
    row.trend = JSON.stringify(trend);
  }
  return { items: rows.map(mapIssue), total, page: filters.page, pageSize: filters.pageSize };
}

function distribution(
  database: TraceDatabase,
  issueId: string,
  expression: string,
): Array<{ name: string; value: number }> {
  const rows = database.sqlite
    .prepare(
      `SELECT ${expression} AS name, COUNT(*) AS value FROM events e
       LEFT JOIN releases r ON r.id = e.release_id
       WHERE e.issue_id = ? GROUP BY name ORDER BY value DESC LIMIT 8`,
    )
    .all(issueId) as Row[];
  return rows.map((row) => ({ name: String(row.name ?? 'Unknown'), value: number(row.value) }));
}

export function getIssue(database: TraceDatabase, issueId: string): IssueDetail | null {
  const row = database.sqlite
    .prepare(
      `SELECT i.*,
        (SELECT r.version FROM events e JOIN releases r ON r.id = e.release_id
         WHERE e.issue_id = i.id ORDER BY e.created_at DESC LIMIT 1) AS latest_release
       FROM issues i WHERE i.id = ?`,
    )
    .get(issueId) as Row | undefined;
  if (!row) return null;
  const sample = database.sqlite
    .prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(issueId) as Row | undefined;
  return {
    ...mapIssue(row),
    sampleEvent: sample ? mapEvent(sample) : null,
    browserDistribution: distribution(
      database,
      issueId,
      `CASE
        WHEN json_extract(e.context_json, '$.device.userAgent') LIKE '%Edg/%' THEN 'Edge'
        WHEN json_extract(e.context_json, '$.device.userAgent') LIKE '%Chrome/%' THEN 'Chrome'
        WHEN json_extract(e.context_json, '$.device.userAgent') LIKE '%Firefox/%' THEN 'Firefox'
        WHEN json_extract(e.context_json, '$.device.userAgent') LIKE '%Safari/%' THEN 'Safari'
        ELSE 'Other' END`,
    ),
    routeDistribution: distribution(database, issueId, 'e.page_url'),
    releaseDistribution: distribution(database, issueId, "COALESCE(r.version, 'Unknown')"),
  };
}

export function listIssueEvents(
  database: TraceDatabase,
  issueId: string,
  limit = 50,
): StoredEvent[] {
  const rows = database.sqlite
    .prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(issueId, Math.min(limit, 200)) as Row[];
  return rows.map(mapEvent);
}

export function getProjectOverview(database: TraceDatabase, projectId: string): ProjectOverview {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const stats = database.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM issues WHERE project_id = ? AND status = 'unresolved') unresolved,
        (SELECT COUNT(*) FROM events e LEFT JOIN issues i ON i.id = e.issue_id
         LEFT JOIN releases r ON r.id = e.release_id
         WHERE COALESCE(i.project_id, r.project_id) = ? AND e.created_at >= ?) events,
        (SELECT COUNT(DISTINCT e.user_id) FROM events e LEFT JOIN issues i ON i.id = e.issue_id
         LEFT JOIN releases r ON r.id = e.release_id
         WHERE COALESCE(i.project_id, r.project_id) = ? AND e.created_at >= ? AND e.user_id IS NOT NULL) users,
        (SELECT COUNT(*) FROM releases WHERE project_id = ?) releases`,
    )
    .get(projectId, projectId, since, projectId, since, projectId) as Row;
  const buckets = database.sqlite
    .prepare(
      `SELECT CAST((e.created_at - ?) / 3600000 AS INTEGER) bucket,
        COUNT(CASE WHEN e.issue_id IS NOT NULL THEN 1 END) errors,
        COUNT(DISTINCT e.user_id) users
       FROM events e LEFT JOIN issues i ON i.id = e.issue_id LEFT JOIN releases r ON r.id = e.release_id
       WHERE COALESCE(i.project_id, r.project_id) = ? AND e.created_at >= ? GROUP BY bucket`,
    )
    .all(since, projectId, since) as Row[];
  const bucketMap = new Map(buckets.map((row) => [number(row.bucket), row]));
  return {
    unresolvedIssues: number(stats.unresolved),
    events24h: number(stats.events),
    affectedUsers24h: number(stats.users),
    releases: number(stats.releases),
    trend: Array.from({ length: 24 }, (_, index) => {
      const row = bucketMap.get(index);
      return {
        timestamp: since + index * 3_600_000,
        errors: number(row?.errors),
        users: number(row?.users),
      };
    }),
  };
}

function metricRating(metric: keyof typeof WEB_VITAL_THRESHOLDS, value: number) {
  const [good, poor] = WEB_VITAL_THRESHOLDS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

export function getPerformanceMetrics(database: TraceDatabase, projectId: string): PerformanceMetric[] {
  const rows = database.sqlite
    .prepare(
      `SELECT e.context_json FROM events e
       JOIN releases r ON r.id = e.release_id
       WHERE r.project_id = ? AND e.type = 'performance' AND e.created_at >= ?`,
    )
    .all(projectId, Date.now() - 7 * 24 * 60 * 60 * 1000) as Row[];
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const context = parseJson<{ payload?: { metric?: string; value?: number } }>(String(row.context_json), {});
    const metric = context.payload?.metric?.toUpperCase();
    const value = Number(context.payload?.value);
    if (metric && Number.isFinite(value)) grouped.set(metric, [...(grouped.get(metric) ?? []), value]);
  }
  return (['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const).map((metric) => {
    const values = grouped.get(metric) ?? [];
    const p75 = percentile(values, 0.75);
    return {
      metric,
      p50: percentile(values, 0.5),
      p75,
      p95: percentile(values, 0.95),
      rating: metricRating(metric, p75),
      samples: values.length,
    };
  });
}

export { mapEvent };
