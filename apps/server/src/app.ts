import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { stripUrlQuery } from '@trace-pilot/shared';
import type { ServerConfig } from './config';
import { createDatabase, ensureDemoProject } from './db/client';
import { registerEventRoutes } from './routes/events';
import { registerIssueRoutes } from './routes/issues';
import { registerProjectRoutes } from './routes/projects';
import { registerDiagnosisRoutes } from './routes/diagnosis';
import { registerSourceMapRoutes } from './routes/sourcemaps';

export interface BuildAppOptions {
  config: ServerConfig;
  logger?: boolean;
}

/**
 * Fastify 应用工厂。返回实例而不是在这里 listen，既方便 app.inject 测试，
 * 也让基准脚本能使用临时数据库启动完全相同的路由栈。
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            serializers: {
              req(request) {
                // 日志保留路径用于排障，但在写日志前删除 query，避免泄露 Token 等参数。
                return {
                  method: request.method,
                  url: stripUrlQuery(request.url),
                  host: request.hostname,
                  remoteAddress: request.ip,
                };
              },
            },
          },
    // 在框架解析 JSON 前限制请求体，防止超大遥测包耗尽内存。
    bodyLimit: 1_048_576,
    requestTimeout: 20_000,
  });
  const database = createDatabase(options.config.databasePath);
  ensureDemoProject(database);

  // Fastify 插件必须 await 注册完成后再挂载依赖它们的路由。
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] });
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 },
  });
  app.get('/health', async () => ({
    status: 'ok',
    service: 'tracepilot-server',
    time: Date.now(),
  }));

  registerEventRoutes(app, database);
  registerProjectRoutes(app, database);
  registerIssueRoutes(app, database);
  registerSourceMapRoutes(app, database, options.config);
  registerDiagnosisRoutes(app, database, options.config);

  app.setErrorHandler((error, request, reply) => {
    // 详细错误只进入服务端日志；500 响应不把堆栈和数据库细节暴露给浏览器。
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

  // 测试、开发热重载和正常退出都经过 onClose，集中释放 SQLite 文件句柄。
  app.addHook('onClose', async () => database.close());
  return app;
}
