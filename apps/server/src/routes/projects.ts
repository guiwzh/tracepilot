import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createProjectSchema, createReleaseSchema } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import {
  getPerformanceOverview,
  getProjectOverview,
  listProjects,
  listReleases,
} from '../services/queries';

function paramId(params: unknown): string {
  return String((params as { projectId?: string }).projectId ?? '');
}

export function registerProjectRoutes(app: FastifyInstance, database: TraceDatabase): void {
  app.get('/api/v1/projects', async () => ({ items: listProjects(database) }));

  app.post('/api/v1/projects', async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_PROJECT',
        message: 'Project name must contain between 2 and 80 characters.',
        details: parsed.error.flatten(),
      });
    }
    const project = {
      id: randomUUID(),
      name: parsed.data.name,
      dsnKey: randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
    };
    database.sqlite
      .prepare('INSERT INTO projects (id, name, dsn_key, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, project.name, project.dsnKey, project.createdAt);
    return reply.code(201).send(project);
  });

  app.get('/api/v1/projects/:projectId/overview', async (request, reply) => {
    const projectId = paramId(request.params);
    const exists = database.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists)
      return reply.code(404).send({ error: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
    return getProjectOverview(database, projectId);
  });

  app.get('/api/v1/projects/:projectId/performance', async (request, reply) => {
    const projectId = paramId(request.params);
    const exists = database.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists)
      return reply.code(404).send({ error: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
    return getPerformanceOverview(database, projectId);
  });

  app.get('/api/v1/projects/:projectId/releases', async (request) => ({
    items: listReleases(database, paramId(request.params)),
  }));

  app.post('/api/v1/projects/:projectId/releases', async (request, reply) => {
    const projectId = paramId(request.params);
    const parsed = createReleaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_RELEASE',
        message: 'Release version is required.',
        details: parsed.error.flatten(),
      });
    }
    const exists = database.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists)
      return reply.code(404).send({ error: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
    const duplicate = database.sqlite
      .prepare('SELECT id FROM releases WHERE project_id = ? AND version = ?')
      .get(projectId, parsed.data.version) as { id: string } | undefined;
    if (duplicate) {
      return reply
        .code(409)
        .send({ error: 'RELEASE_EXISTS', message: 'This release already exists.' });
    }
    const release = {
      id: randomUUID(),
      projectId,
      version: parsed.data.version,
      commitSha: parsed.data.commitSha ?? null,
      createdAt: Date.now(),
    };
    database.sqlite
      .prepare(
        'INSERT INTO releases (id, project_id, version, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(release.id, release.projectId, release.version, release.commitSha, release.createdAt);
    return reply.code(201).send(release);
  });
}
