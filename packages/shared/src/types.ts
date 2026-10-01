import type {
  Breadcrumb,
  DiagnosisResult,
  IssueLevel,
  IssueStatus,
  MonitorEvent,
  ProjectSettings,
} from './schemas';

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
    /** 堆栈里产物文件的 Debug ID，见 MonitorEvent.debugIds。 */
    debugIds?: MonitorEvent['debugIds'];
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
  /** map 里的 debugId 字段；构建插件产出的 map 才有，手动上传的旧 map 为 null。 */
  debugId: string | null;
  createdAt: number;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** GET / PUT /projects/:id/settings 的响应：项目自己的设置，以及没有单独设置时生效的服务端默认值。 */
export interface ProjectSettingsResponse {
  settings: ProjectSettings;
  serverDefaults: {
    /** 每分钟事件数上限；0 表示不限。 */
    eventsPerMinute: number;
    /** 服务端是否启用了突增保护；关闭时项目里的开关不起作用。 */
    spikeProtection: boolean;
  };
}

/** 入站过滤丢弃一个事件的原因。 */
export type FilterReason =
  'browser-extension' | 'web-crawler' | 'localhost' | 'error-message' | 'release';
/** 接入限流拒收一批事件的原因。 */
export type RateLimitReason = 'project-rate-limit' | 'spike-protection';

/** 一段时间内这个项目的上报去向：收下、被过滤、被限流，按原因分开计数。 */
export interface IngestStats {
  windowHours: number;
  /** 新写入的事件数（重复送达的不算）。 */
  accepted: number;
  filtered: Partial<Record<FilterReason, number>>;
  rateLimited: Partial<Record<RateLimitReason, number>>;
  /** 按小时，最早的在前。 */
  hourly: Array<{ hour: number; accepted: number; filtered: number; rateLimited: number }>;
}

/** 一个项目的 API 令牌（只读，给 MCP 客户端用）。令牌本身只在创建时返回一次，服务端只存它的哈希。 */
export interface ApiToken {
  id: string;
  projectId: string;
  name: string;
  /** 令牌的前几个字符，用来在列表里认出是哪一个。 */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** 创建令牌的响应：多了令牌明文，只出现这一次。 */
export interface CreatedApiToken extends ApiToken {
  token: string;
}
