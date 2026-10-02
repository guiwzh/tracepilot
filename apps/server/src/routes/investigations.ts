import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isTerminalInvestigationEvent, type InvestigationStreamEvent } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { AgUiEncoder, parseAgUiCursor } from '../investigation/agui';
import { fixBriefFor } from '../investigation/fixBrief';
import type { InvestigationService } from '../investigation/service';
import { latestCompletedRun, type InvestigationStore } from '../investigation/store';

function param(params: unknown, key: string): string {
  return String((params as Record<string, unknown>)[key] ?? '');
}

/**
 * 心跳间隔。长时间没有数据的连接可能被代理或负载均衡当作空闲连接断开，
 * 每 15 秒发一行 SSE 注释（以冒号开头，浏览器会忽略）保持连接活跃。
 */
const HEARTBEAT_MS = 15_000;

/**
 * 调查接口。启动、查询、取消是普通 REST；进度通过 SSE 推送。
 *
 * 选 SSE 而不是 WebSocket：数据只从服务端流向浏览器，取消走一个普通 POST 就够了；
 * SSE 基于普通 HTTP，浏览器自带断线重连并会在请求头里带上 Last-Event-ID，
 * 服务端据此从库里回放缺失的事件。
 *
 * SSE（Server-Sent Events）：一个不结束的 HTTP 响应，Content-Type 为 text/event-stream，
 * 服务端不断往里写文本。每条消息由几行「字段: 值」组成，以一个空行结尾：
 *
 *   id: 7                      消息编号（这里用 seq），重连时浏览器把它放进 Last-Event-ID
 *   event: tool.called         事件类型，前端用 addEventListener('tool.called', …) 接收
 *   data: {"seq":7,...}        内容，这里是一行 JSON
 *   （空行）
 *
 * 浏览器端对应的 API 是 EventSource（见 dashboard 的 useInvestigationStream.ts）。
 */
export function registerInvestigationRoutes(
  app: FastifyInstance,
  service: InvestigationService,
  store: InvestigationStore,
  database: TraceDatabase,
  dashboardUrl: string,
): void {
  // 修复简报（investigation/fixBrief.ts）：把一次已完成的调查整理成交给编码 Agent 的 Markdown。
  // 按运行取，或取某个 Issue 最近一次完成的调查。
  app.get('/api/v1/investigations/:runId/fix-brief', async (request, reply) => {
    const run = store.getRun(param(request.params, 'runId'));
    if (!run) {
      return reply
        .code(404)
        .send({ error: 'INVESTIGATION_NOT_FOUND', message: 'Investigation not found.' });
    }
    const brief = fixBriefFor(database, run, dashboardUrl);
    if (!brief) {
      return reply.code(409).send({
        error: 'INVESTIGATION_NOT_COMPLETED',
        message: 'Only a completed investigation has a report to brief from.',
      });
    }
    return brief;
  });

  app.get('/api/v1/issues/:issueId/fix-brief', async (request, reply) => {
    const run = latestCompletedRun(database, param(request.params, 'issueId'));
    const brief = run && fixBriefFor(database, run, dashboardUrl);
    if (!brief) {
      return reply.code(404).send({
        error: 'NO_COMPLETED_INVESTIGATION',
        message: 'This issue has no completed investigation yet.',
      });
    }
    return brief;
  });

  // 发起调查。立即返回运行记录，调查本身在后台进行，进度从下面的 /events 接口订阅。
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

  // 某个 Issue 的调查历史（最近 20 次）。
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
    // 202：取消信号已发出，但调查要在下一个检查点才真正停下，终止事件随后从 SSE 推送。
    return reply.code(202).send({ status: 'cancelling' });
  });

  // SSE 事件流：先回放已有事件，调查仍在进行时继续实时推送，收到终止事件后关闭。
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

    if (run.status !== 'running' && store.eventsAfter(runId, after).length === 0) {
      // 204 让 EventSource 停止重连；否则连接结束后它会每隔几秒重连一次，永不停止。
      return reply.code(204).send();
    }
    streamRun(
      reply,
      store,
      runId,
      after,
      (record) =>
        `id: ${record.seq}\nevent: ${record.event.type}\ndata: ${JSON.stringify(record)}\n\n`,
    );
  });

  // 同一次调查的 AG-UI 事件流（investigation/agui.ts）：给 CopilotKit 这类 AG-UI 前端看。
  // 事件 id 是「seq.序号」，Last-Event-ID 或 ?after= 续传；编码器有状态，所以总是从头编码、跳过已发的。
  app.get('/api/v1/investigations/:runId/ag-ui', async (request, reply) => {
    const run = store.getRun(param(request.params, 'runId'));
    if (!run) {
      return reply.code(404).send({ error: 'INVESTIGATION_NOT_FOUND', message: 'Not found.' });
    }
    const cursor = parseAgUiCursor(
      request.headers['last-event-id'] ?? (request.query as Record<string, unknown>).after,
    );
    const format = agUiFormatter(run.id, run.issueId, cursor);
    if (run.status !== 'running') {
      // 已经结束、续传位置之后也没有事件了：同样 204，让 EventSource 别再重连。
      const probe = agUiFormatter(run.id, run.issueId, cursor);
      if (store.eventsAfter(run.id, 0).every((record) => probe(record) === '')) {
        return reply.code(204).send();
      }
    }
    streamRun(reply, store, run.id, 0, format);
  });

  // AG-UI 的 Agent 端点：收 RunAgentInput，threadId 是 Issue id，发起（或接上进行中的）调查并推送它的事件。
  // @ag-ui/client 的 HttpAgent 指向这里就能驱动排障 Agent。这次调查的 runId 由服务端生成：同一个 Issue
  // 只跑一个调查，接上别人发起的那次时没法用请求里的 runId。断开连接不取消调查，取消走 /cancel。
  app.post('/api/v1/ag-ui', async (request, reply) => {
    const input = RunAgentInputSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: 'INVALID_RUN_AGENT_INPUT',
        message: 'Expected an AG-UI RunAgentInput whose threadId is the issue id.',
        details: input.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const result = service.start(input.data.threadId);
    if (result.status === 'issue_not_found') {
      return reply.code(404).send({ error: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
    }
    if (result.status === 'busy') {
      return reply.code(429).send({
        error: 'INVESTIGATIONS_BUSY',
        message: 'Too many investigations are running. Try again shortly.',
      });
    }
    const { run } = result;
    streamRun(reply, store, run.id, 0, agUiFormatter(run.id, run.issueId, parseAgUiCursor('')));
  });
}

/**
 * 一次调查的 SSE 推送：先回放已有事件，调查仍在进行时继续实时推送，收到终止事件后关闭。
 * format 把一条记录写成 SSE 文本（可以是空串：AG-UI 续传时已经发过的部分）。
 */
function streamRun(
  reply: FastifyReply,
  store: InvestigationStore,
  runId: string,
  after: number,
  format: (record: InvestigationStreamEvent) => string,
): void {
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
  // retry：告诉浏览器断线后隔 2 秒再重连（默认值因浏览器而异）。
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
  // seq 不大于已发送的直接跳过，这就是下面回放时的去重。
  const send = (record: InvestigationStreamEvent) => {
    if (closed || record.seq <= lastSent) return;
    lastSent = record.seq;
    const chunk = format(record);
    if (chunk) response.write(chunk);
    // 终止事件之后不会再有新事件，关闭连接。
    if (isTerminalInvestigationEvent(record.event)) close();
  };

  // 先订阅、再回放：订阅之后再查一次库，补上「开头查 backlog 之后、订阅之前」产生的事件；
  // 回放期间实时到达的新事件先进缓冲，回放完再冲出，靠 seq 去重。这样既不漏也不重。
  // 当前 SQLite 查询是同步的，这个窗口实际为零；换成异步数据库后这个顺序就是必需的。
  const buffered: InvestigationStreamEvent[] = [];
  let replaying = true;
  const unsubscribe = store.subscribe(runId, (record) => {
    if (replaying) buffered.push(record);
    else send(record);
  });
  for (const record of store.eventsAfter(runId, after)) send(record);
  for (const record of store.eventsAfter(runId, lastSent)) send(record);
  replaying = false;
  for (const record of buffered) send(record);

  // 浏览器关页面或断网时，底层连接关闭，清理心跳和订阅（调查本身不受影响，继续在后台跑）。
  // 听响应的 close 而不是请求的：请求体读完时请求对象就会触发 close，带请求体的 POST（AG-UI 端点）
  // 会在第一批事件之后就被当成断开。
  response.on('close', close);
}

/**
 * 一次调查的 AG-UI 编码：每条记录编码成若干事件，续传位置（含）之前的不写。
 * SSE 只写 id 和 data：AG-UI 的 SSE 约定里没有 event 字段，EventSource 的 onmessage 才收得到。
 */
function agUiFormatter(
  runId: string,
  issueId: string,
  cursor: { seq: number; index: number },
): (record: InvestigationStreamEvent) => string {
  const encoder = new AgUiEncoder(runId, issueId);
  return (record) =>
    encoder
      .encode(record)
      .filter((_, index) =>
        record.seq === cursor.seq ? index > cursor.index : record.seq > cursor.seq,
      )
      .map(({ id, event }) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
}
