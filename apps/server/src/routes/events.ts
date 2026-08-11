import type { FastifyInstance } from 'fastify';
import { envelopeSchema } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { ingestEnvelope } from '../services/events';

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
