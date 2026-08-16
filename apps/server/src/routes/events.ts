import type { FastifyInstance } from 'fastify';
import { envelopeSchema, redactSensitive } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { ingestEnvelope } from '../services/events';
import { symbolicateStack } from '../services/sourcemaps';

/** 浏览器遥测入口：运行时校验 → 授权/入库 → 可选 Source Map 还原。 */
export function registerEventRoutes(app: FastifyInstance, database: TraceDatabase): void {
  app.post('/api/v1/envelopes', { config: { rawBody: false } }, async (request, reply) => {
    // request.body 来自网络，必须先通过 Zod 才能作为 EventEnvelope 使用。
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
      // 先完成事务入库，再逐个做异步源码还原；Source Map 缺失不影响事件接收。
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
            .run(redactSensitive(originalStack), event.eventId);
        }
      }
      // 202 表示服务端已经接收并处理该遥测批次，不要求浏览器等待后续调查动作。
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
    // 仅供本地 Playground 稳定制造 503，不代理任何真实上游服务。
    return reply.code(503).send({ error: 'CHECKOUT_UPSTREAM_UNAVAILABLE', retryAfter: 30 });
  });
}
