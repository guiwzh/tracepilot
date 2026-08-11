import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { diagnoseIssue, getDiagnosis, listDiagnoses } from '../services/diagnosis';

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
