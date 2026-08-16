import type { FastifyInstance } from 'fastify';
import { issueStatusSchema, updateIssueStatusSchema } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { getIssue, listIssueEvents, listIssues } from '../services/queries';

function stringParam(params: unknown, key: string): string {
  return String((params as Record<string, unknown>)[key] ?? '');
}

function queryRecord(query: unknown): Record<string, string | undefined> {
  return (query ?? {}) as Record<string, string | undefined>;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  // 查询参数均来自字符串；夹紧范围可避免负 LIMIT 或一次读取过多事件。
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

function optionalTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function registerIssueRoutes(app: FastifyInstance, database: TraceDatabase): void {
  app.get('/api/v1/projects/:projectId/issues', async (request) => {
    // 路由层只负责规范化 HTTP 参数，动态 SQL 的参数化拼装留给 queries 服务。
    const query = queryRecord(request.query);
    return listIssues(database, stringParam(request.params, 'projectId'), {
      page: positiveInteger(query.page, 1, 1_000_000),
      pageSize: positiveInteger(query.pageSize, 25, 100),
      status: query.status,
      level: query.level,
      release: query.release,
      browser: query.browser,
      route: query.route,
      search: query.search,
      sort: query.sort,
      order: query.order,
      from: optionalTimestamp(query.from),
      to: optionalTimestamp(query.to),
    });
  });

  app.get('/api/v1/issues/:issueId', async (request, reply) => {
    const issue = getIssue(database, stringParam(request.params, 'issueId'));
    if (!issue)
      return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
    return issue;
  });

  app.get('/api/v1/issues/:issueId/events', async (request, reply) => {
    const issueId = stringParam(request.params, 'issueId');
    const issue = database.sqlite.prepare('SELECT 1 FROM issues WHERE id = ?').get(issueId);
    if (!issue)
      return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
    const limit = positiveInteger(queryRecord(request.query).limit, 50, 200);
    return { items: listIssueEvents(database, issueId, limit) };
  });

  app.patch('/api/v1/issues/:issueId/status', async (request, reply) => {
    const issueId = stringParam(request.params, 'issueId');
    const parsed = updateIssueStatusSchema.safeParse(request.body);
    if (!parsed.success || !issueStatusSchema.safeParse(parsed.data?.status).success) {
      return reply.code(400).send({
        error: 'INVALID_ISSUE_STATUS',
        message: 'Status must be unresolved, resolved, or ignored.',
      });
    }
    // prepared statement 的占位符确保状态和 ID 不会被解释为 SQL。
    const result = database.sqlite
      .prepare('UPDATE issues SET status = ? WHERE id = ?')
      .run(parsed.data.status, issueId);
    if (result.changes === 0) {
      return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
    }
    return { id: issueId, status: parsed.data.status };
  });
}
