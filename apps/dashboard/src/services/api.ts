import type {
  DiagnosisRecord,
  IssueDetail,
  IssueListResponse,
  PerformanceMetric,
  Project,
  ProjectOverview,
  Release,
  SourceMapRecord,
  StoredEvent,
} from '@trace-pilot/shared';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4318';

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
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(body.message ?? `Request failed with ${response.status}`, response.status, body.error);
  }
  return response.json() as Promise<T>;
}

export const api = {
  projects: () => request<{ items: Project[] }>('/api/v1/projects'),
  createProject: (name: string) =>
    request<Project>('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  overview: (projectId: string) => request<ProjectOverview>(`/api/v1/projects/${projectId}/overview`),
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
    request<{ items: PerformanceMetric[] }>(`/api/v1/projects/${projectId}/performance`),
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
