import type { FastifyInstance } from 'fastify';
import { envelopeSchema } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { ingestEnvelope } from '../services/events';
import { symbolicateStack } from '../services/sourcemaps';

export function registerEventRoutes(app: FastifyInstance, database: TraceDatabase): void {
  app.post('/api/v1/envelopes', { config: { rawBody: false } }, async (request, reply) => {
    const parsed = envelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_ENVELOPE',
        message: 'The telemetry envelope does not match the public event schema.',
        details: parsed.error.flatten(),
      });
    }
    try {
      const result = ingestEnvelope(database, parsed.data);
      for (const event of parsed.data.events) {
        const stack = typeof event.payload.stack === 'string' ? event.payload.stack : undefined;
        if (!stack) continue;
        const release = database.sqlite
          .prepare('SELECT id FROM releases WHERE project_id = ? AND version = ?')
          .get(event.projectId, event.release) as { id: string } | undefined;
        if (!release) continue;
        const originalStack = await symbolicateStack(database, release.id, stack);
        if (originalStack) {
          database.sqlite
            .prepare('UPDATE events SET original_stack = ? WHERE id = ?')
            .run(originalStack, event.eventId);
        }
      }
      return reply.code(202).send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INGEST_FAILED';
      if (code === 'INVALID_DSN' || code === 'PROJECT_DSN_MISMATCH') {
        return reply.code(403).send({
          error: code,
          message: 'The DSN is not authorized for the event project.',
        });
      }
      throw error;
    }
  });

  app.get('/api/v1/playground/fail', async (_request, reply) => {
    return reply.code(503).send({ error: 'CHECKOUT_UPSTREAM_UNAVAILABLE', retryAfter: 30 });
  });
}
