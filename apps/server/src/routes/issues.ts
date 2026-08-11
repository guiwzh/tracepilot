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

export function registerIssueRoutes(app: FastifyInstance, database: TraceDatabase): void {
  app.get('/api/v1/projects/:projectId/issues', async (request) => {
    const query = queryRecord(request.query);
    return listIssues(database, stringParam(request.params, 'projectId'), {
      page: Math.max(1, Number(query.page ?? 1)),
      pageSize: Math.max(1, Math.min(100, Number(query.pageSize ?? 25))),
      status: query.status,
      level: query.level,
      release: query.release,
      browser: query.browser,
      route: query.route,
      search: query.search,
      sort: query.sort,
      order: query.order,
      from: query.from ? Number(query.from) : undefined,
      to: query.to ? Number(query.to) : undefined,
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
    const limit = Number(queryRecord(request.query).limit ?? 50);
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
    const result = database.sqlite
      .prepare('UPDATE issues SET status = ? WHERE id = ?')
      .run(parsed.data.status, issueId);
    if (result.changes === 0) {
      return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
    }
    return { id: issueId, status: parsed.data.status };
  });
}
