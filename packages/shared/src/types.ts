import type { Breadcrumb, DiagnosisResult, IssueLevel, IssueStatus, MonitorEvent } from './schemas';

/**
 * 这些接口描述 Server 返回给 Dashboard 的公开 DTO。
 * 数据库使用 snake_case，前端使用 camelCase，转换集中在 Server 的 queries 服务中完成。
 */
export interface Project {
  id: string;
  name: string;
  dsnKey: string;
  createdAt: number;
  issueCount?: number;
  eventCount?: number;
}

export interface Release {
  id: string;
  projectId: string;
  version: string;
  commitSha?: string | null;
  createdAt: number;
  sourceMapCount?: number;
}

export interface Issue {
  id: string;
  projectId: string;
  fingerprint: string;
  title: string;
  status: IssueStatus;
  level: IssueLevel;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
  userCount: number;
  latestRelease?: string | null;
  trend?: number[];
}

export interface StoredEvent {
  id: string;
  issueId?: string | null;
  releaseId?: string | null;
  type: MonitorEvent['eventType'];
  message: string;
  stack?: string | null;
  originalStack?: string | null;
  pageUrl: string;
  userId?: string | null;
  context: {
    page: MonitorEvent['page'];
    device: MonitorEvent['device'];
    payload: Record<string, unknown>;
    environment: string;
    release: string;
    /** 事件生效的采样率；这一字段出现之前入库的事件没有它，视为 1。 */
    sampleRate?: number;
  };
  breadcrumbs: Breadcrumb[];
  createdAt: number;
}

export interface IssueDetail extends Issue {
  sampleEvent: StoredEvent | null;
  browserDistribution: Array<{ name: string; value: number }>;
  routeDistribution: Array<{ name: string; value: number }>;
  releaseDistribution: Array<{ name: string; value: number }>;
}

export interface IssueListResponse {
  items: Issue[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProjectOverview {
  unresolvedIssues: number;
  /** 24 小时内归入 Issue 的事件数（错误、失败的请求、资源加载失败），不含性能样本。 */
  events24h: number;
  /** 24 小时内遇到过上述事件的去重用户数。 */
  affectedUsers24h: number;
  releases: number;
  trend: Array<{ timestamp: number; errors: number; users: number }>;
}

export interface PerformanceMetric {
  metric: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
  p50: number;
  p75: number;
  p95: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  samples: number;
}

export interface PerformanceComparison {
  metric: PerformanceMetric['metric'];
  name: string;
  p75: number;
  rating: PerformanceMetric['rating'];
  samples: number;
}

export interface PerformanceTrendPoint {
  timestamp: number;
  metric: PerformanceMetric['metric'];
  p75: number;
  samples: number;
}

export interface PerformanceOverview {
  items: PerformanceMetric[];
  byRelease: PerformanceComparison[];
  byRoute: PerformanceComparison[];
  byBrowser: PerformanceComparison[];
  /** LCP、CLS、INP 各自 p75 最差的元素（name 是 CSS 选择器），来自 web-vitals 归因。 */
  byElement: PerformanceComparison[];
  trend: PerformanceTrendPoint[];
}

export interface DiagnosisRecord {
  id: string;
  issueId: string;
  model: string;
  inputHash: string;
  result: DiagnosisResult;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: number;
  cached?: boolean;
}

export interface SourceMapRecord {
  id: string;
  releaseId: string;
  minifiedFile: string;
  createdAt: number;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
