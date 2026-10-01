import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { envelopeSchema, type FilterReason } from '@trace-pilot/shared';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { authorizeEnvelope, IngestError, ingestEnvelope } from '../services/events';
import { inboundFilter } from '../services/inboundFilters';
import type { IngestGuard } from '../services/ingestGuard';
import type { OutcomeRecorder } from '../services/outcomes';
import { getProjectSettings } from '../services/projectSettings';

function invalidJson(): Error {
  return Object.assign(new Error('The telemetry envelope is not valid JSON.'), { statusCode: 400 });
}

/** 接入路由用到的进程内状态：限流器和上报去向的计数器，app.ts 创建一份供所有请求共用。 */
export interface IngestProtection {
  guard: IngestGuard;
  outcomes: OutcomeRecorder;
  config: Pick<ServerConfig, 'ingestRateLimitPerMinute' | 'spikeProtection'>;
}

/**
 * 浏览器遥测入口：运行时校验 → 授权 → 入站过滤 → 限流 → Source Map 还原 → 聚合与入库
 * （后两步见 services/events.ts）。
 *
 * 授权靠 DSN Key：SDK 初始化时配置的公开接入键，服务端据此确认事件属于哪个项目。
 * 它必然出现在浏览器代码里，所以不是密钥——它能挡住配错项目的上报，挡不住有人故意伪造上报。
 * 伪造上报能做到的最坏程度由限流兜住：一个项目被刷满，别的项目照常接入。
 */
export function registerEventRoutes(
  app: FastifyInstance,
  database: TraceDatabase,
  protection: IngestProtection,
): void {
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
    registerEnvelopeRoute(scope, database, protection);
  });
}

function registerEnvelopeRoute(
  app: FastifyInstance,
  database: TraceDatabase,
  { guard, outcomes, config }: IngestProtection,
): void {
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
      const projectId = authorizeEnvelope(database, parsed.data);
      const settings = getProjectSettings(database, projectId);

      // 入站过滤：被过滤的事件不入库、不占限流额度，只按原因计数。
      const filter = inboundFilter(settings.inboundFilters);
      const filtered = new Map<FilterReason, number>();
      const kept = parsed.data.events.filter((event) => {
        const reason = filter(event);
        if (reason) filtered.set(reason, (filtered.get(reason) ?? 0) + 1);
        return reason === null;
      });
      for (const [reason, count] of filtered) outcomes.record(projectId, 'filtered', count, reason);
      const filteredCount = parsed.data.events.length - kept.length;
      if (kept.length === 0) {
        return reply.code(202).send({
          accepted: 0,
          duplicates: 0,
          metricUpdates: 0,
          filtered: filteredCount,
          issueIds: [],
        });
      }

      // 限流与突增保护：整个信封要么都收、要么都不收，拒收时 SDK 按 Retry-After 退避后重发这一批。
      const decision = guard.admit(projectId, kept.length, {
        eventsPerMinute: settings.rateLimit.eventsPerMinute ?? config.ingestRateLimitPerMinute,
        spikeProtection: config.spikeProtection && settings.rateLimit.spikeProtection,
      });
      if (!decision.ok) {
        outcomes.record(projectId, 'rate_limited', kept.length, decision.reason);
        return reply
          .code(429)
          .header('retry-after', String(decision.retryAfterSeconds))
          .send({
            error: 'RATE_LIMITED',
            reason: decision.reason,
            message:
              decision.reason === 'spike-protection'
                ? 'Event volume is far above this project’s normal rate; retry later.'
                : 'This project has exceeded its event rate limit; retry later.',
            retryAfter: decision.retryAfterSeconds,
          });
      }

      // 还原在入库之前、事务之外进行（聚合要用还原后的栈帧）。还原失败或找不到 map 都只是少了原始栈，
      // 事件照常入库：这里绝不能返回 500，否则 SDK 会把已经收下的一批反复重发。
      const { result, symbolicationFailures } = await ingestEnvelope(database, {
        ...parsed.data,
        events: kept,
      });
      outcomes.record(projectId, 'accepted', result.accepted);
      if (symbolicationFailures > 0) {
        request.log.warn({ failed: symbolicationFailures }, 'source map symbolication failed');
      }
      return reply.code(202).send({ ...result, filtered: filteredCount });
    } catch (error) {
      // DSN Key 不存在，或事件声明的项目与 Key 不符：凭据问题，返回 403，SDK 不会重试。
      // 其余错误继续抛出，交给 app.ts 的统一错误处理返回 500。
      if (error instanceof IngestError) {
        return reply.code(403).send({
          error: error.code,
          message: 'The DSN is not authorized for the event project.',
        });
      }
      throw error;
    }
  });
}
