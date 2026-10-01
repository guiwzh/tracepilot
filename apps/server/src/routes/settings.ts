import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectSettingsSchema, type ProjectSettingsResponse } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { ingestStats } from '../services/outcomes';
import { getProjectSettings, saveProjectSettings } from '../services/projectSettings';
import type { IngestProtection } from './events';

/**
 * 项目设置（入站过滤、限流）与上报去向统计。和其他管理接口一样，当前没有鉴权。
 * 设置在下一个信封到达时就生效：接入路由每次都读最新的设置（编译好的过滤规则按内容缓存）。
 */
function projectIdOf(params: unknown): string {
  return String((params as { projectId?: string }).projectId ?? '');
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  database: TraceDatabase,
  { outcomes, config }: IngestProtection,
): void {
  const exists = (projectId: string) =>
    Boolean(database.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId));
  const notFound = { error: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
  const response = (projectId: string): ProjectSettingsResponse => ({
    settings: getProjectSettings(database, projectId),
    serverDefaults: {
      eventsPerMinute: config.ingestRateLimitPerMinute,
      spikeProtection: config.spikeProtection,
    },
  });

  app.get('/api/v1/projects/:projectId/settings', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    if (!exists(projectId)) return reply.code(404).send(notFound);
    return response(projectId);
  });

  // PUT：整份替换。工作台总是提交完整的设置，部分更新的合并规则（数组是追加还是替换）就不必定义。
  app.put('/api/v1/projects/:projectId/settings', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    const parsed = projectSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_SETTINGS',
        message: 'The project settings do not match the expected shape.',
        details: z.flattenError(parsed.error),
      });
    }
    if (!saveProjectSettings(database, projectId, parsed.data)) {
      return reply.code(404).send(notFound);
    }
    return response(projectId);
  });

  app.get('/api/v1/projects/:projectId/ingest-stats', async (request, reply) => {
    const projectId = projectIdOf(request.params);
    if (!exists(projectId)) return reply.code(404).send(notFound);
    const hours = Number((request.query as { hours?: string }).hours ?? 24);
    // 先把内存里还没写下去的计数写完，刚发生的拒收在页面上立即看得到。
    outcomes.flush();
    return ingestStats(
      database,
      projectId,
      Number.isInteger(hours) ? Math.min(168, Math.max(1, hours)) : 24,
    );
  });
}
