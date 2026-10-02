import type {
  AlertDelivery,
  AlertRule,
  AlertTestResult,
  ApiToken,
  CreateAlertRule,
  CreatedApiToken,
  FixBrief,
  IngestStats,
  InvestigationRun,
  IssueActivity,
  IssueDetail,
  IssueListResponse,
  IssueStatus,
  IssueSubstatus,
  PerformanceOverview,
  Project,
  ProjectOverview,
  ProjectSettings,
  ProjectSettingsResponse,
  Release,
  SourceMapRecord,
  StoredEvent,
  UpdateAlertRule,
} from '@trace-pilot/shared';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4318';

/** 把 HTTP 状态和服务端业务错误码一起保留下来，页面可展示统一错误状态。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 泛型 T 只是类型断言：响应 JSON 在浏览器端不做运行时校验，形状是否正确依赖服务端
  // 按 shared 里的类型返回（服务端的 Zod 校验针对的是它收到的请求，而不是这里的响应）。
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers:
      // 浏览器会为 FormData 自动生成带 boundary 的 Content-Type，手动设置反而会破坏上传；
      // 没有请求体时也不声明 JSON，否则服务端会把空请求体当成非法 JSON 拒绝。
      init?.body === undefined || init.body instanceof FormData
        ? init?.headers
        : { 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    // 错误响应不一定是 JSON（例如代理错误页），因此解析失败时回退为空对象。
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(
      body.message ?? `Request failed with ${response.status}`,
      response.status,
      body.error,
    );
  }
  // 204 No Content（例如吊销令牌）没有响应体，解析 JSON 会失败。
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  // 所有 URL 和 HTTP 方法集中在这里，页面组件不直接拼接 fetch。
  projects: () => request<{ items: Project[] }>('/api/v1/projects'),
  createProject: (name: string) =>
    request<Project>('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  overview: (projectId: string) =>
    request<ProjectOverview>(`/api/v1/projects/${projectId}/overview`),
  issues: (projectId: string, search: URLSearchParams) =>
    request<IssueListResponse>(`/api/v1/projects/${projectId}/issues?${search}`),
  issue: (issueId: string) => request<IssueDetail>(`/api/v1/issues/${issueId}`),
  issueEvents: (issueId: string) =>
    request<{ items: StoredEvent[] }>(`/api/v1/issues/${issueId}/events?limit=100`),
  updateIssue: (issueId: string, status: IssueStatus, untilEscalating = false) =>
    request<{ id: string; status: IssueStatus; substatus: IssueSubstatus | null }>(
      `/api/v1/issues/${issueId}/status`,
      { method: 'PATCH', body: JSON.stringify({ status, untilEscalating }) },
    ),
  issueActivity: (issueId: string) =>
    request<{ items: IssueActivity[] }>(`/api/v1/issues/${issueId}/activity`),
  mergeIssues: (targetId: string, issueIds: string[]) =>
    request<{ id: string; title: string; merged: number; eventCount: number; userCount: number }>(
      `/api/v1/issues/${targetId}/merge`,
      { method: 'POST', body: JSON.stringify({ issueIds }) },
    ),
  performance: (projectId: string) =>
    request<PerformanceOverview>(`/api/v1/projects/${projectId}/performance`),
  releases: (projectId: string) =>
    request<{ items: Release[] }>(`/api/v1/projects/${projectId}/releases`),
  createRelease: (projectId: string, version: string, commitSha?: string) =>
    request<Release>(`/api/v1/projects/${projectId}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version, commitSha: commitSha || undefined }),
    }),
  sourceMaps: (releaseId: string) =>
    request<{ items: SourceMapRecord[] }>(`/api/v1/releases/${releaseId}/source-maps`),
  uploadSourceMap: (releaseId: string, minifiedFile: string, file: File) => {
    const form = new FormData();
    form.append('minifiedFile', minifiedFile);
    form.append('file', file);
    return request<SourceMapRecord>(`/api/v1/releases/${releaseId}/source-maps`, {
      method: 'POST',
      body: form,
    });
  },
  settings: (projectId: string) =>
    request<ProjectSettingsResponse>(`/api/v1/projects/${projectId}/settings`),
  saveSettings: (projectId: string, settings: ProjectSettings) =>
    request<ProjectSettingsResponse>(`/api/v1/projects/${projectId}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  tokens: (projectId: string) =>
    request<{ items: ApiToken[] }>(`/api/v1/projects/${projectId}/tokens`),
  createToken: (projectId: string, name: string) =>
    request<CreatedApiToken>(`/api/v1/projects/${projectId}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  revokeToken: (tokenId: string) =>
    request<void>(`/api/v1/tokens/${tokenId}`, { method: 'DELETE' }),
  alertRules: (projectId: string) =>
    request<{ items: AlertRule[] }>(`/api/v1/projects/${projectId}/alert-rules`),
  createAlertRule: (projectId: string, rule: CreateAlertRule) =>
    request<AlertRule>(`/api/v1/projects/${projectId}/alert-rules`, {
      method: 'POST',
      body: JSON.stringify(rule),
    }),
  updateAlertRule: (ruleId: string, patch: UpdateAlertRule) =>
    request<AlertRule>(`/api/v1/alert-rules/${ruleId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteAlertRule: (ruleId: string) =>
    request<void>(`/api/v1/alert-rules/${ruleId}`, { method: 'DELETE' }),
  testAlertRule: (ruleId: string) =>
    request<AlertTestResult>(`/api/v1/alert-rules/${ruleId}/test`, { method: 'POST' }),
  alertDeliveries: (projectId: string) =>
    request<{ items: AlertDelivery[] }>(`/api/v1/projects/${projectId}/alert-deliveries`),
  ingestStats: (projectId: string) =>
    request<IngestStats>(`/api/v1/projects/${projectId}/ingest-stats`),
  investigations: (issueId: string) =>
    request<{ items: InvestigationRun[] }>(`/api/v1/issues/${issueId}/investigations`),
  startInvestigation: (issueId: string) =>
    request<InvestigationRun>(`/api/v1/issues/${issueId}/investigations`, { method: 'POST' }),
  fixBrief: (runId: string) => request<FixBrief>(`/api/v1/investigations/${runId}/fix-brief`),
  cancelInvestigation: (runId: string) =>
    request<{ status: string }>(`/api/v1/investigations/${runId}/cancel`, { method: 'POST' }),
  // EventSource 自己发请求，不经过 request()；首次连接用 after 指定起点，重连由浏览器带 Last-Event-ID。
  investigationEventsUrl: (runId: string, after = 0) =>
    `${API_URL}/api/v1/investigations/${runId}/events?after=${after}`,
};
