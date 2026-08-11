import type {
  DiagnosisRecord,
  IssueDetail,
  IssueListResponse,
  PerformanceOverview,
  Project,
  ProjectOverview,
  Release,
  SourceMapRecord,
  StoredEvent,
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
  // 泛型 T 只约束调用方看到的类型；真实 JSON 的运行时校验由 Server 的 Zod Schema 负责。
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers:
      // 浏览器会为 FormData 自动生成带 boundary 的 Content-Type，手动设置反而会破坏上传。
      init?.body instanceof FormData
        ? init.headers
        : { 'content-type': 'application/json', ...init?.headers },
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
  updateIssue: (issueId: string, status: string) =>
    request<{ id: string; status: string }>(`/api/v1/issues/${issueId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
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
  diagnoses: (issueId: string) =>
    request<{ items: DiagnosisRecord[] }>(`/api/v1/issues/${issueId}/diagnoses`),
  diagnose: (issueId: string, force = false) =>
    request<DiagnosisRecord>(`/api/v1/issues/${issueId}/diagnoses`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
};
