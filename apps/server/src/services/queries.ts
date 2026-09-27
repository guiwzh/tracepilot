import {
  WEB_VITAL_THRESHOLDS,
  type Breadcrumb,
  type Issue,
  type IssueDetail,
  type IssueListResponse,
  type PerformanceComparison,
  type PerformanceMetric,
  type PerformanceOverview,
  type Project,
  type ProjectOverview,
  type Release,
  type StoredEvent,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson, percentile } from '../lib/json';

/**
 * 工作台所有「读」接口背后的查询。
 *
 * 数据库的列名是 snake_case（issue_count），接口返回给前端的是 shared 包里定义的 camelCase 对象
 * （issueCount）。每个查询先用 SQL 取出行，再由 map* 函数转换成前端要的形状（DTO，数据传输对象）。
 *
 * 复杂的统计直接写 SQL，比在 JS 里循环计算更快，也更清楚地控制分页、JSON 提取和时间分桶。
 * 常见写法速查：
 * - `a JOIN b ON 条件`：把两张表里满足条件的行拼成一行；`LEFT JOIN` 保留左表所有行，右表没有匹配时填 NULL。
 * - `GROUP BY x` + `COUNT(*)`：按 x 分组后统计每组行数，相当于 JS 里先 groupBy 再取长度。
 * - `EXISTS (子查询)`：只判断「是否存在至少一行」，找到一行就停，比 COUNT 便宜。
 * - `json_extract(列, '$.a.b')`：从存成 JSON 文本的列里取字段。
 * - `LIMIT n OFFSET m`：分页，跳过前 m 行取 n 行。
 */
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
  // context/breadcrumbs 以 JSON 文本存储；解析失败时返回最小可用上下文而不是让整个页面报错。
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

/**
 * 项目列表及每个项目的 Issue 数、事件数。SELECT 里的两个括号是「关联子查询」：
 * 对外层的每个项目 p 各执行一次计数。项目只有个位数，这样写最直白。
 */
export function listProjects(database: TraceDatabase): Project[] {
  const rows = database.sqlite
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM issues i WHERE i.project_id = p.id) AS issue_count,
        (SELECT COUNT(*) FROM events e JOIN releases r ON r.id = e.release_id
         WHERE r.project_id = p.id) AS event_count
       FROM projects p ORDER BY p.created_at DESC`,
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

/**
 * 项目的全部 Release 及各自上传了几个 Source Map。用 LEFT JOIN 是为了让还没有上传 map 的版本
 * 也出现在结果里（计数为 0）；普通 JOIN 会把它们整行丢掉。
 */
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

/**
 * Issue 列表：按筛选条件动态拼出 WHERE，分页，并为每行附上最近 6 小时的趋势。
 *
 * 动态 SQL 的做法：conditions 收集 SQL 片段，params 按相同顺序收集参数，最后用 AND 连接。
 * 按版本、浏览器、路由筛选时，条件其实落在 Issue 的「事件」上（一个 Issue 可能跨多个版本），
 * 所以用 EXISTS 子查询表达「这个 Issue 至少有一个事件满足条件」。
 */
export function listIssues(
  database: TraceDatabase,
  projectId: string,
  filters: IssueFilters,
): IssueListResponse {
  // SQL 片段来自固定代码，所有用户值都进入 params 占位符，避免字符串拼接注入。
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
    conditions.push(
      'EXISTS (SELECT 1 FROM events er JOIN releases rr ON rr.id = er.release_id WHERE er.issue_id = i.id AND rr.version = ?)',
    );
    params.push(filters.release);
  }
  if (filters.browser) {
    const userAgent = "json_extract(eb.context_json, '$.device.userAgent')";
    if (filters.browser === 'Edge') {
      conditions.push(
        `EXISTS (SELECT 1 FROM events eb WHERE eb.issue_id = i.id AND ${userAgent} LIKE '%Edg/%')`,
      );
    } else if (filters.browser === 'Chrome') {
      conditions.push(
        `EXISTS (SELECT 1 FROM events eb WHERE eb.issue_id = i.id AND ${userAgent} LIKE '%Chrome/%' AND ${userAgent} NOT LIKE '%Edg/%')`,
      );
    } else if (filters.browser === 'Safari') {
      conditions.push(
        `EXISTS (SELECT 1 FROM events eb WHERE eb.issue_id = i.id AND ${userAgent} LIKE '%Safari/%' AND ${userAgent} NOT LIKE '%Chrome/%')`,
      );
    } else {
      conditions.push(
        `EXISTS (SELECT 1 FROM events eb WHERE eb.issue_id = i.id AND ${userAgent} LIKE ?)`,
      );
      params.push(`%${filters.browser}%`);
    }
  }
  if (filters.route) {
    conditions.push(
      'EXISTS (SELECT 1 FROM events ep WHERE ep.issue_id = i.id AND ep.page_url LIKE ?)',
    );
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
    (
      database.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM issues i WHERE ${where}`)
        .get(...params) as Row
    ).count,
  );
  const sortColumns: Record<string, string> = {
    lastSeen: 'i.last_seen_at',
    firstSeen: 'i.first_seen_at',
    events: 'i.event_count',
    users: 'i.user_count',
  };
  // ORDER BY 列名不能用普通占位符，因此必须通过白名单映射。
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
    // 每个 Issue 生成最近 6 小时的 7 个点，空桶显式补 0，Sparkline 才不会错位。
    // 分桶方式：(事件时间 - 起点) / 1 小时，取整后就是它落在第几个小时。
    // 已知限制：这里对每个 Issue 各查一次，一页 N 行就多 N 次查询（所谓 N+1 查询）。
    // 当前每页最多 100 行、本地 SQLite 单次查询在亚毫秒级，可以接受；数据量变大时应改成一条 GROUP BY 查询。
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

/** 某个维度（浏览器、路由、版本）上的事件分布，取数量最多的前 8 项，供详情页的环形图使用。 */
function distribution(
  database: TraceDatabase,
  issueId: string,
  expression: string,
): Array<{ name: string; value: number }> {
  // expression 只由本文件内固定调用传入，绝不直接接受 HTTP 查询参数。
  const rows = database.sqlite
    .prepare(
      `SELECT ${expression} AS name, COUNT(*) AS value FROM events e
       LEFT JOIN releases r ON r.id = e.release_id
       WHERE e.issue_id = ? GROUP BY name ORDER BY value DESC LIMIT 8`,
    )
    .all(issueId) as Row[];
  return rows.map((row) => ({ name: String(row.name ?? 'Unknown'), value: number(row.value) }));
}

/**
 * Issue 详情：基本信息 + 最新一条事件（作为「现场」样本）+ 三个维度的分布。
 * latest_release 用子查询取该 Issue 最近一条事件所在的版本。
 */
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
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
  const rows = database.sqlite
    .prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(issueId, safeLimit) as Row[];
  return rows.map(mapEvent);
}

/**
 * 项目概览：未解决 Issue 数、24 小时错误事件数与受影响用户数、版本数，以及按小时分桶的 24 小时趋势。
 *
 * 事件数和用户数只统计归入 Issue 的事件（错误、失败的请求、资源加载失败）。性能样本不属于任何
 * Issue：早先把它们也算进来，「受影响用户」就成了「这段时间访问过的所有用户」，
 * 每个只上报过一次性能样本的访客都被算作受影响。
 */
export function getProjectOverview(database: TraceDatabase, projectId: string): ProjectOverview {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const stats = database.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM issues WHERE project_id = ? AND status = 'unresolved') unresolved,
        (SELECT COUNT(*) FROM events e JOIN issues i ON i.id = e.issue_id
         WHERE i.project_id = ? AND e.created_at >= ?) events,
        (SELECT COUNT(DISTINCT e.user_id) FROM events e JOIN issues i ON i.id = e.issue_id
         WHERE i.project_id = ? AND e.created_at >= ? AND e.user_id IS NOT NULL) users,
        (SELECT COUNT(*) FROM releases WHERE project_id = ?) releases`,
    )
    .get(projectId, projectId, since, projectId, since, projectId) as Row;
  // 第 24 小时的桶只有「恰好此刻」的事件才会落进去（事件时间可以比服务端时钟最多快一分钟），
  // 并入最后一个桶，否则它们计入了总数却不出现在趋势图里。
  const buckets = database.sqlite
    .prepare(
      `SELECT MIN(23, CAST((e.created_at - ?) / 3600000 AS INTEGER)) bucket,
        COUNT(*) errors,
        COUNT(DISTINCT e.user_id) users
       FROM events e JOIN issues i ON i.id = e.issue_id
       WHERE i.project_id = ? AND e.created_at >= ? GROUP BY bucket`,
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

function metricRating(
  metric: keyof typeof WEB_VITAL_THRESHOLDS,
  value: number,
): PerformanceMetric['rating'] {
  const [good, poor] = WEB_VITAL_THRESHOLDS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

const PERFORMANCE_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
type PerformanceMetricName = (typeof PERFORMANCE_METRICS)[number];

interface PerformanceSample {
  metric: PerformanceMetricName;
  value: number;
  release: string;
  route: string;
  browser: string;
  createdAt: number;
}

function browserName(userAgent: string): string {
  if (userAgent.includes('Edg/')) return 'Edge';
  if (userAgent.includes('Chrome/')) return 'Chrome';
  if (userAgent.includes('Firefox/')) return 'Firefox';
  if (userAgent.includes('Safari/')) return 'Safari';
  return 'Other';
}

function routeName(pageUrl: string, route?: string): string {
  if (route) return route.replace(/[?#].*$/, '') || '/';
  try {
    return new URL(pageUrl).pathname || '/';
  } catch {
    return pageUrl.replace(/[?#].*$/, '') || 'Unknown';
  }
}

/**
 * 取出项目最近 7 天的全部性能样本，在 JS 里分组并计算分位数。
 * 已知限制：样本全部读进内存。演示数据量下没问题，数据量大时应在数据库里聚合，或改用列式存储。
 */
function getPerformanceSamples(database: TraceDatabase, projectId: string): PerformanceSample[] {
  // 指标名和数值存在事件上下文的 JSON 里，不需要为每种指标单独加列。
  const rows = database.sqlite
    .prepare(
      `SELECT e.context_json, e.page_url, e.created_at, r.version
       FROM events e JOIN releases r ON r.id = e.release_id
       WHERE r.project_id = ? AND e.type = 'performance' AND e.created_at >= ?`,
    )
    .all(projectId, Date.now() - 7 * 24 * 60 * 60 * 1000) as Row[];
  const samples: PerformanceSample[] = [];
  for (const row of rows) {
    const context = parseJson<{
      page?: { route?: string };
      device?: { userAgent?: string };
      payload?: { metric?: string; value?: number };
    }>(String(row.context_json), {});
    const metric = context.payload?.metric?.toUpperCase();
    const value = Number(context.payload?.value);
    if (!PERFORMANCE_METRICS.includes(metric as PerformanceMetricName) || !Number.isFinite(value)) {
      continue;
    }
    samples.push({
      metric: metric as PerformanceMetricName,
      value,
      release: String(row.version ?? 'Unknown'),
      route: routeName(String(row.page_url), context.page?.route),
      browser: browserName(context.device?.userAgent ?? ''),
      createdAt: number(row.created_at),
    });
  }
  return samples;
}

function performanceMetrics(samples: PerformanceSample[]): PerformanceMetric[] {
  // 先按指标分组，再对每组计算 p50/p75/p95；p75 同时用于体验评级。
  // 取出数组后 push，而不是每次展开重建：展开会让分组退化为 O(样本数²)。
  const grouped = new Map<PerformanceMetricName, number[]>();
  for (const sample of samples) {
    const values = grouped.get(sample.metric);
    if (values) values.push(sample.value);
    else grouped.set(sample.metric, [sample.value]);
  }
  return PERFORMANCE_METRICS.map((metric) => {
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

function performanceComparison(
  samples: PerformanceSample[],
  dimension: 'release' | 'route' | 'browser',
): PerformanceComparison[] {
  // 先按维度总样本数选 Top 8，避免高基数路由把 Dashboard 撑成无限列表。
  const totals = new Map<string, number>();
  for (const sample of samples)
    totals.set(sample[dimension], (totals.get(sample[dimension]) ?? 0) + 1);
  const visibleNames = new Set(
    [...totals.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([name]) => name),
  );
  const grouped = new Map<string, number[]>();
  for (const sample of samples) {
    if (!visibleNames.has(sample[dimension])) continue;
    const key = `${sample[dimension]}\u0000${sample.metric}`;
    const values = grouped.get(key);
    if (values) values.push(sample.value);
    else grouped.set(key, [sample.value]);
  }
  return [...grouped.entries()]
    .map(([key, values]) => {
      const [name = 'Unknown', metric = 'LCP'] = key.split('\u0000');
      const metricName = metric as PerformanceMetricName;
      const p75 = percentile(values, 0.75);
      return {
        name,
        metric: metricName,
        p75,
        rating: metricRating(metricName, p75),
        samples: values.length,
      };
    })
    .sort((left, right) => right.samples - left.samples || left.name.localeCompare(right.name));
}

export function getPerformanceOverview(
  database: TraceDatabase,
  projectId: string,
): PerformanceOverview {
  // 趋势桶固定为 7 天；没有样本的日期仍返回 samples=0，前端显示断点而不是伪造 0ms。
  const samples = getPerformanceSamples(database, projectId);
  const windowStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  const trendGroups = new Map<string, number[]>();
  for (const sample of samples) {
    const bucket = Math.max(0, Math.min(6, Math.floor((sample.createdAt - windowStart) / day)));
    const key = `${bucket}\u0000${sample.metric}`;
    const values = trendGroups.get(key);
    if (values) values.push(sample.value);
    else trendGroups.set(key, [sample.value]);
  }
  return {
    items: performanceMetrics(samples),
    byRelease: performanceComparison(samples, 'release'),
    byRoute: performanceComparison(samples, 'route'),
    byBrowser: performanceComparison(samples, 'browser'),
    trend: PERFORMANCE_METRICS.flatMap((metric) =>
      Array.from({ length: 7 }, (_, bucket) => {
        const values = trendGroups.get(`${bucket}\u0000${metric}`) ?? [];
        return {
          timestamp: windowStart + bucket * day,
          metric,
          p75: percentile(values, 0.75),
          samples: values.length,
        };
      }),
    ),
  };
}

export { mapEvent };
