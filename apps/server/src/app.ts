import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { stripUrlQuery } from '@trace-pilot/shared';
import type { ServerConfig } from './config';
import { createDatabase, ensureDemoProject } from './db/client';
import type { InvestigationLimits } from './investigation/agent';
import {
  defaultModelClientFactory,
  InvestigationService,
  type ModelClientFactory,
} from './investigation/service';
import { InvestigationStore } from './investigation/store';
import { registerEventRoutes } from './routes/events';
import { registerIssueRoutes } from './routes/issues';
import { registerProjectRoutes } from './routes/projects';
import { registerDiagnosisRoutes } from './routes/diagnosis';
import { registerInvestigationRoutes } from './routes/investigations';
import { registerSourceMapRoutes } from './routes/sourcemaps';

/** buildApp 的参数；测试通过它注入临时数据库配置和模型替身。 */
export interface BuildAppOptions {
  config: ServerConfig;
  logger?: boolean;
  /** 测试注入的模型替身；默认按配置选择真实模型或离线脚本。 */
  modelClientFactory?: ModelClientFactory;
  investigationLimits?: Partial<InvestigationLimits>;
}

/**
 * 服务端的组装入口：创建 Fastify 实例、打开数据库、注册插件和全部路由。
 *
 * 一个 HTTP 请求在服务端经过的分层：
 *
 *   浏览器 / SDK ──► routes/*.ts        取参数、做运行时校验、决定返回哪个 HTTP 状态码
 *                      └─► services/*.ts、investigation/*   业务逻辑，读写数据库
 *                            └─► db/client.ts           SQLite：一个本地文件，同步读写
 *
 * 用前端的话类比：routes 像组件里的事件处理函数，只负责接收输入、调用逻辑、给出反馈；
 * services 像抽出去的业务 hooks / 工具函数；数据库像一个会持久化到磁盘的全局 store。
 *
 * 这里用到的 Fastify 概念：
 * - 插件（app.register）：给应用加能力的函数，例如跨域、文件上传解析。插件有「封装作用域」，
 *   在某个 register 回调里加的解析器、钩子只对这个作用域内的路由生效，routes/events.ts 利用了这一点。
 * - 钩子（app.addHook）：挂在请求或应用生命周期上的回调。onClose 在应用关闭时执行，
 *   作用类似 React effect 的清理函数。
 * - app.inject：不监听端口，在进程内直接模拟一次 HTTP 请求。测试和基准脚本都靠它，
 *   这也是这里只返回实例、不调用 listen 的原因（真正监听端口在 index.ts）。
 *
 * 路由处理函数直接 return 一个对象时，Fastify 把它序列化成 JSON，状态码默认 200；
 * 需要别的状态码时用 reply.code(xxx).send(...)。本服务用到的状态码：
 *
 *   200 成功           201 创建了新资源（项目、Release、调查）   202 已接收，处理可能还在进行（遥测接入）
 *   204 成功但没有内容（SSE：调查已结束，让浏览器别再重连）
 *   400 请求本身不合法（字段缺失、格式错误）   403 凭据与项目不匹配（DSN Key）
 *   404 资源不存在     409 与现有状态冲突（版本已存在、调查已结束）   415 文件类型不对
 *   429 太忙，稍后重试（同时进行的调查已达上限）
 *   500 服务端 bug     502 依赖的上游（模型服务）出错，本服务自身正常
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify 内置 pino 日志，每条请求一行 JSON。
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
    // 请求体上限 1 MiB：超出的请求在解析 JSON 之前就被拒绝（413），恶意的超大遥测包耗不尽内存。
    bodyLimit: 1_048_576,
    // 接收一个完整请求（不是返回响应）的最长时间；SSE 这种长时间推送的响应不受它影响。
    requestTimeout: 20_000,
  });

  // 数据库和调查服务在应用启动时创建一次，所有请求共用（相当于单例）。
  const database = createDatabase(options.config.databasePath);
  ensureDemoProject(database);
  const investigationStore = new InvestigationStore(database);
  const investigations = new InvestigationService(
    database,
    options.config,
    investigationStore,
    options.modelClientFactory ?? defaultModelClientFactory(options.config),
    options.investigationLimits,
  );

  // 插件要先注册完成（await），依赖它们的路由才能正常工作。
  // origin: true 表示把请求的 Origin 原样回显为允许来源，也就是允许任何网页跨域调用。
  // 本地单用户的 MVP 可以接受；部署到公网前必须改成明确的域名白名单。
  // Retry-After 不在 CORS 默认可读的响应头里：不显式暴露，跨域上报的 SDK 读不到它，
  // 限流或维护时就无法照服务端要求的时间退避。
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    exposedHeaders: ['retry-after'],
  });
  // multipart/form-data 是浏览器上传文件时的请求格式（Source Map 上传用到）。
  // 单文件最大 10 MB、只接受 1 个文件和 4 个普通字段，防止上传把内存或磁盘撑满。
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 },
  });

  // 健康检查：E2E 测试、冒烟测试和部署平台都靠它判断服务是否已经启动完成。
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
  registerInvestigationRoutes(app, investigations, investigationStore);

  // 任何路由里抛出、没有被自己处理的错误都会落到这里（包括代码 bug）。
  app.setErrorHandler((error, request, reply) => {
    // 详细错误只进入服务端日志；500 响应不把堆栈和数据库细节暴露给浏览器。
    request.log.error({ err: error }, 'request failed');
    // 框架或插件抛出的错误常带 statusCode（例如 413 请求体过大、400 非法 JSON），沿用它；
    // 没有的就是意料之外的问题，一律按 500 处理。
    const statusCode =
      typeof error === 'object' && error && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const status = statusCode >= 400 ? statusCode : 500;
    const message = error instanceof Error ? error.message : 'Unknown request error';
    return reply.code(status).send({
      error: status === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED',
      // 4xx 是客户端的问题，保留原因方便调用方修正；5xx 只给一句模糊描述。
      message: status === 500 ? 'The request could not be completed.' : message,
    });
  });

  // app.close() 时执行：测试结束、index.ts 收到 SIGTERM / SIGINT（部署停止、tsx watch 重启、Ctrl+C）
  // 都会走到这里。先中止进行中的调查并等它们写完终止事件，再关闭 SQLite 文件句柄。
  app.addHook('onClose', async () => {
    await investigations.shutdown();
    database.close();
  });
  return app;
}
