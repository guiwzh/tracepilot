import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { envelopeSchema } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { ingestEnvelope } from '../services/events';
import { symbolicateEvents } from '../services/sourcemaps';

function invalidJson(): Error {
  return Object.assign(new Error('The telemetry envelope is not valid JSON.'), { statusCode: 400 });
}

/**
 * 浏览器遥测入口：运行时校验 → 授权/入库 → 可选 Source Map 还原。
 *
 * 授权靠 DSN Key：SDK 初始化时配置的公开接入键，服务端据此确认事件属于哪个项目。
 * 它必然出现在浏览器代码里，所以不是密钥——它能挡住配错项目的上报，挡不住有人故意伪造上报。
 * 真正的防伪需要额外的签名或限流，当前 MVP 没有做。
 */
export function registerEventRoutes(app: FastifyInstance, database: TraceDatabase): void {
  // Fastify 按请求头的 Content-Type 选择「内容解析器」，把原始请求体变成 request.body。
  // 默认的 text/plain 解析器只给出字符串；SDK 却用 text/plain 发送 JSON：它是 CORS 安全列表类型，
  // 跨域上报不触发预检，sendBeacon 也不必走带凭据的预检。
  // 所以在一个封装作用域（register 回调）里换掉 text/plain 的解析器，只影响接入路由。
  //
  // register 返回的 Promise 不需要在这里 await：Fastify 会在 app.ready() / listen() 时
  // 等所有注册完成，再开始处理请求。
  void app.register(async (scope) => {
    scope.removeContentTypeParser('text/plain');
    scope.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => {
      // done(错误, 结果) 是 Node 风格的回调：成功时第一个参数为 null。
      try {
        done(null, JSON.parse(String(body)));
      } catch {
        done(invalidJson(), undefined);
      }
    });
    registerEnvelopeRoute(scope, database);
  });
}

function registerEnvelopeRoute(app: FastifyInstance, database: TraceDatabase): void {
  app.post('/api/v1/envelopes', async (request, reply) => {
    // request.body 来自网络，必须先通过 Zod 才能作为 EventEnvelope 使用。
    const parsed = envelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_ENVELOPE',
        message: 'The telemetry envelope does not match the public event schema.',
        details: z.flattenError(parsed.error),
      });
    }
    try {
      const { result, stacks } = ingestEnvelope(database, parsed.data);
      // 先完成事务入库，再对新写入的事件做源码还原（读 map 文件是异步的）。
      // 还原失败或找不到 map 都只是少了原始栈：symbolicateEvents 不会抛错，事件已经被接收。
      const { failed } = await symbolicateEvents(database, stacks);
      if (failed > 0) request.log.warn({ failed }, 'source map symbolication failed');
      // 202 表示服务端已经接收并处理该遥测批次，不要求浏览器等待后续调查动作。
      return reply.code(202).send(result);
    } catch (error) {
      // ingestEnvelope 用错误消息表达业务错误码：DSN Key 不存在，或事件声明的项目与 Key 不符。
      // 其余错误继续抛出，交给 app.ts 的统一错误处理返回 500。
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
}
