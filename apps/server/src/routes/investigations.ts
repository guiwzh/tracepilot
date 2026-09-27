import type { FastifyInstance } from 'fastify';
import type { InvestigationStreamEvent } from '@trace-pilot/shared';
import type { InvestigationService } from '../investigation/service';
import type { InvestigationStore } from '../investigation/store';

function param(params: unknown, key: string): string {
  return String((params as Record<string, unknown>)[key] ?? '');
}

function isTerminal(record: InvestigationStreamEvent): boolean {
  const type = record.event.type;
  return type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled';
}

const HEARTBEAT_MS = 15_000;

/**
 * 调查接口。启动、查询、取消是普通 REST；进度通过 SSE 推送。
 *
 * 选 SSE 而不是 WebSocket：数据只从服务端流向浏览器，取消走一个普通 POST 就够了；
 * SSE 基于普通 HTTP，浏览器自带断线重连并会在请求头里带上 Last-Event-ID，
 * 服务端据此从库里回放缺失的事件。
 */
export function registerInvestigationRoutes(
  app: FastifyInstance,
  service: InvestigationService,
  store: InvestigationStore,
): void {
  app.post('/api/v1/issues/:issueId/investigations', async (request, reply) => {
    const result = service.start(param(request.params, 'issueId'));
    if (result.status === 'issue_not_found') {
      return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
    }
    if (result.status === 'busy') {
      return reply.code(429).send({
        error: 'INVESTIGATIONS_BUSY',
        message: 'Too many investigations are running. Try again shortly.',
      });
    }
    // 已有进行中的调查时返回它本身（200），而不是再开一次计费的运行。
    return reply.code(result.status === 'created' ? 201 : 200).send(result.run);
  });

  app.get('/api/v1/issues/:issueId/investigations', async (request) => ({
    items: store.listRuns(param(request.params, 'issueId')),
  }));

  app.get('/api/v1/investigations/:runId', async (request, reply) => {
    const run = store.getRun(param(request.params, 'runId'));
    if (!run) {
      return reply.code(404).send({ error: 'INVESTIGATION_NOT_FOUND', message: 'Not found.' });
    }
    return run;
  });

  app.post('/api/v1/investigations/:runId/cancel', async (request, reply) => {
    const outcome = service.cancel(param(request.params, 'runId'));
    if (outcome === 'not_found') {
      return reply.code(404).send({ error: 'INVESTIGATION_NOT_FOUND', message: 'Not found.' });
    }
    if (outcome === 'not_running') {
      return reply
        .code(409)
        .send({ error: 'INVESTIGATION_NOT_RUNNING', message: 'The investigation already ended.' });
    }
    return reply.code(202).send({ status: 'cancelling' });
  });

  app.get('/api/v1/investigations/:runId/events', async (request, reply) => {
    const runId = param(request.params, 'runId');
    const run = store.getRun(runId);
    if (!run) {
      return reply.code(404).send({ error: 'INVESTIGATION_NOT_FOUND', message: 'Not found.' });
    }
    // 浏览器自动重连时带 Last-Event-ID 请求头；首次连接无法自定义请求头，用 ?after= 表达。
    const header = request.headers['last-event-id'];
    const query = (request.query as Record<string, unknown>).after;
    const after = Math.max(0, Number(header ?? query ?? 0) || 0);

    const backlog = store.eventsAfter(runId, after);
    if (run.status !== 'running' && backlog.length === 0) {
      // 204 让 EventSource 停止重连；否则连接结束后它会每隔几秒重连一次，永不停止。
      return reply.code(204).send();
    }

    // 接管原始响应：之后由这里直接写 socket，Fastify 不再处理这个回复。
    // 跨域头是 CORS 插件在 onRequest 阶段设置到 reply 上的，接管后要手动带上。
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关闭反向代理（如 Nginx）的响应缓冲，否则事件会攒成一批才到浏览器。
      'x-accel-buffering': 'no',
    });
    response.write('retry: 2000\n\n');

    let lastSent = after;
    let closed = false;
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), HEARTBEAT_MS);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    };
    const send = (record: InvestigationStreamEvent) => {
      if (closed || record.seq <= lastSent) return;
      lastSent = record.seq;
      response.write(
        `id: ${record.seq}\nevent: ${record.event.type}\ndata: ${JSON.stringify(record)}\n\n`,
      );
      if (isTerminal(record)) close();
    };

    // 先订阅、再回放：回放期间产生的新事件先进缓冲，回放完再按 seq 去重冲出，
    // 既不会漏掉「查库之后、订阅之前」产生的事件，也不会重复发送。
    // 当前 SQLite 查询是同步的，这个窗口实际为零；换成异步数据库后这个顺序就是必需的。
    const buffered: InvestigationStreamEvent[] = [];
    let replaying = true;
    const unsubscribe = store.subscribe(runId, (record) => {
      if (replaying) buffered.push(record);
      else send(record);
    });
    for (const record of backlog) send(record);
    for (const record of store.eventsAfter(runId, lastSent)) send(record);
    replaying = false;
    for (const record of buffered) send(record);

    request.raw.on('close', close);
  });
}
