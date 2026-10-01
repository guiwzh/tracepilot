import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createApiTokenSchema } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/apiTokens';

/**
 * 项目的 API 令牌：给 MCP 客户端访问 /mcp 用。令牌明文只在创建的响应里出现一次。
 * 这些是管理接口，和其他管理接口一样当前没有鉴权（本地单用户 MVP）：能打开工作台的人就能发令牌。
 */
function param(params: unknown, key: 'projectId' | 'tokenId'): string {
  return String((params as Record<string, string | undefined>)[key] ?? '');
}

export function registerTokenRoutes(app: FastifyInstance, database: TraceDatabase): void {
  const projectExists = (projectId: string) =>
    Boolean(database.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId));

  app.get('/api/v1/projects/:projectId/tokens', async (request, reply) => {
    const projectId = param(request.params, 'projectId');
    if (!projectExists(projectId)) {
      return reply.code(404).send({ error: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
    }
    return { items: listApiTokens(database, projectId) };
  });

  app.post('/api/v1/projects/:projectId/tokens', async (request, reply) => {
    const projectId = param(request.params, 'projectId');
    const parsed = createApiTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_TOKEN_REQUEST',
        message: 'Give the token a name of 1 to 80 characters.',
        details: z.flattenError(parsed.error),
      });
    }
    if (!projectExists(projectId)) {
      return reply.code(404).send({ error: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
    }
    return reply.code(201).send(createApiToken(database, projectId, parsed.data.name));
  });

  app.delete('/api/v1/tokens/:tokenId', async (request, reply) => {
    if (!revokeApiToken(database, param(request.params, 'tokenId'))) {
      return reply.code(404).send({ error: 'TOKEN_NOT_FOUND', message: 'Token not found.' });
    }
    return reply.code(204).send();
  });
}
