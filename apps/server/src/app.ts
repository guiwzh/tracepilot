import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { ServerConfig } from './config';
import { createDatabase, ensureDemoProject } from './db/client';
import { registerEventRoutes } from './routes/events';
import { registerIssueRoutes } from './routes/issues';
import { registerProjectRoutes } from './routes/projects';

export interface BuildAppOptions {
  config: ServerConfig;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1_048_576,
    requestTimeout: 20_000,
  });
  const database = createDatabase(options.config.databasePath);
  ensureDemoProject(database);

  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] });
  app.get('/health', async () => ({ status: 'ok', service: 'tracepilot-server', time: Date.now() }));

  registerEventRoutes(app, database);
  registerProjectRoutes(app, database);
  registerIssueRoutes(app, database);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode =
      typeof error === 'object' && error && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const status = statusCode >= 400 ? statusCode : 500;
    const message = error instanceof Error ? error.message : 'Unknown request error';
    return reply.code(status).send({
      error: status === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED',
      message: status === 500 ? 'The request could not be completed.' : message,
    });
  });

  app.addHook('onClose', async () => database.close());
  return app;
}
