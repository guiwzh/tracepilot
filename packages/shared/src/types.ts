import type { Breadcrumb, DiagnosisResult, IssueLevel, IssueStatus, MonitorEvent } from './schemas';

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
  events24h: number;
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
