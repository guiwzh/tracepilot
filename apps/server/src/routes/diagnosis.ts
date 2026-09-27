import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { diagnoseIssue, getDiagnosis, listDiagnoses } from '../services/diagnosis';

/**
 * 单次诊断接口：一次模型调用生成诊断报告，按证据内容缓存。
 * 工作台已经改用排障 Agent（routes/investigations.ts），这组接口保留为 API，并作为评测里的对照组。
 */

// 即使只有一个布尔字段也使用 Schema，避免字符串 "false" 被当作 true。
const requestSchema = z.object({ force: z.boolean().optional().default(false) });

function idParam(params: unknown, key: string): string {
  return String((params as Record<string, unknown>)[key] ?? '');
}

export function registerDiagnosisRoutes(
  app: FastifyInstance,
  database: TraceDatabase,
  config: ServerConfig,
): void {
  app.get('/api/v1/issues/:issueId/diagnoses', async (request, reply) => {
    const issueId = idParam(request.params, 'issueId');
    const issue = database.sqlite.prepare('SELECT 1 FROM issues WHERE id = ?').get(issueId);
    if (!issue)
      return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
    return { items: listDiagnoses(database, issueId) };
  });

  app.post('/api/v1/issues/:issueId/diagnoses', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'INVALID_DIAGNOSIS_REQUEST', message: 'The force flag must be boolean.' });
    }
    try {
      const diagnosis = await diagnoseIssue(
        database,
        config,
        idParam(request.params, 'issueId'),
        parsed.data.force,
      );
      if (!diagnosis)
        return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
      return reply.code(201).send(diagnosis);
    } catch (error) {
      // 模型或结构化输出失败被隔离为 502；已存储的 Issue 证据仍然可以查询。
      request.log.error({ err: error }, 'diagnosis generation failed');
      return reply.code(502).send({
        error: 'DIAGNOSIS_FAILED',
        message: 'Diagnosis could not be generated. Issue evidence remains available.',
      });
    }
  });

  app.get('/api/v1/diagnoses/:diagnosisId', async (request, reply) => {
    const diagnosis = getDiagnosis(database, idParam(request.params, 'diagnosisId'));
    if (!diagnosis) {
      return reply
        .code(404)
        .send({ error: 'DIAGNOSIS_NOT_FOUND', message: 'Diagnosis not found.' });
    }
    return diagnosis;
  });
}
