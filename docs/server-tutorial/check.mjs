/**
 * 练习自测：把你的答案写进 answers/<编号>.mjs，然后运行
 *
 *   node docs/server-tutorial/check.mjs 03
 *   node docs/server-tutorial/check.mjs        # 检查全部
 *
 * 判分方式是「用真实 HTTP 请求打你的 handler，比对响应」，不是比对代码文本，
 * 所以写法和参考答案不同、但响应一致就算通过。
 *
 * 答案文件的格式：
 *
 *   export default function handler(req, res, store) { ... }
 *
 * 前两个参数就是 node:http 的原生参数。第三个 store 是数据层，
 * 对应真实项目里 registerIssueRoutes(app, database) 注入的那个 database。
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './lib/store.mjs';

const answersDir = resolve(dirname(fileURLToPath(import.meta.url)), 'answers');

// ---------------------------------------------------------------------------
// 参考答案用到的小工具。这些不是「框架」，就是最朴素的 Node 代码——
// 认识它们之后再看 Fastify，你会发现框架只是把这些包装得更顺手。
// ---------------------------------------------------------------------------

/** 把 JSON 写进响应。注意 Content-Type 要显式设置，Node 不会替你猜。 */
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(body);
}

/**
 * 读取请求 body。
 *
 * 这是前端最陌生的一点：req 是一个「流」，body 不是一次性拿到的属性，
 * 而是分块到达、要自己拼起来的。浏览器 fetch 帮你封装掉了这一层。
 */
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/** 读 body 并解析 JSON，失败返回 { ok: false }，而不是抛异常。 */
async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * 解析 URL。req.url 只有 path + query，没有协议和主机，
 * 所以要补一个 base 才能交给 URL 类。
 */
function parseUrl(req) {
  return new URL(req.url, 'http://localhost');
}

/** 把查询参数夹到合法区间。对应 apps/server/src/routes/issues.ts 的 positiveInteger。 */
function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const URL_VALUE_KEY = /^(?:url|uri|href|referrer|page[-_]?url|request[-_]?url)$/i;

/** 删除 URL 的 query 和 hash。对应 packages/shared/src/redaction.ts 的 stripUrlQuery。 */
function stripUrlQuery(value) {
  try {
    const url = new URL(value, 'http://tracepilot.local');
    url.search = '';
    url.hash = '';
    return url.origin === 'http://tracepilot.local' ? url.pathname : url.toString();
  } catch {
    return value.replace(/[?#].*$/, '');
  }
}

/** 递归脱敏。对应 packages/shared/src/redaction.ts 的 redactSensitive。 */
function redact(value, depth = 0) {
  if (depth > 8) return '[Max depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = '[REDACTED]';
      } else if (URL_VALUE_KEY.test(key) && typeof item === 'string') {
        result[key] = stripUrlQuery(item);
      } else {
        result[key] = redact(item, depth + 1);
      }
    }
    return result;
  }
  return value;
}

const VALID_STATUS = ['unresolved', 'resolved', 'ignored'];

// ---------------------------------------------------------------------------
// 12 道练习
// ---------------------------------------------------------------------------

export const EXERCISES = [
  {
    id: '01',
    title: '返回一个 JSON 响应',
    prompt: [
      '实现 GET /health，返回状态码 200，body 是 {"status":"ok","service":"tracepilot-server"}。',
      '响应头 Content-Type 必须是 application/json; charset=utf-8。',
      '（对应 apps/server/src/app.ts 的 /health 路由。）',
    ].join('\n'),
    hint: 'res.writeHead(状态码, 头对象) 之后 res.end(字符串)。JSON 要自己 JSON.stringify，Node 不会替你序列化。',
    compareHeaders: ['content-type'],
    requests: [{ method: 'GET', path: '/health' }],
    solution(req, res) {
      sendJson(res, 200, { status: 'ok', service: 'tracepilot-server' });
    },
  },

  {
    id: '02',
    title: '按请求方法分流',
    prompt: [
      'GET /api/v1/projects 返回 200，body 是 { items: store.listProjects() }。',
      '其它请求方法返回 405，body 是 { error: "METHOD_NOT_ALLOWED" }，并带响应头 Allow: GET。',
      '（405 的含义是「这个地址存在，但不接受这个方法」，与 404 不同。）',
    ].join('\n'),
    hint: 'req.method 是大写字符串，例如 "GET"、"POST"。',
    compareHeaders: ['allow'],
    requests: [
      { method: 'GET', path: '/api/v1/projects' },
      { method: 'POST', path: '/api/v1/projects' },
      { method: 'DELETE', path: '/api/v1/projects' },
    ],
    solution(req, res, store) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
        return;
      }
      sendJson(res, 200, { items: store.listProjects() });
    },
  },

  {
    id: '03',
    title: '读取查询参数做分页',
    prompt: [
      'GET /api/v1/issues?projectId=<id>&page=<n>&pageSize=<n>',
      '返回 200，body 是 { items, total, page, pageSize }。',
      'items 是 store.listIssues(projectId) 分页后的那一页；total 是分页「之前」的总数。',
      'page 默认 1，pageSize 默认 25。缺少 projectId 时返回 400 { error: "PROJECT_ID_REQUIRED" }。',
    ].join('\n'),
    hint: 'new URL(req.url, "http://localhost").searchParams.get("page") 拿到的永远是字符串或 null。分页切片是 slice((page-1)*pageSize, page*pageSize)。',
    requests: [
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project' },
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project&page=2&pageSize=3' },
      { method: 'GET', path: '/api/v1/issues?projectId=legacy-admin' },
      { method: 'GET', path: '/api/v1/issues' },
    ],
    solution(req, res, store) {
      const url = parseUrl(req);
      const projectId = url.searchParams.get('projectId');
      if (!projectId) {
        sendJson(res, 400, { error: 'PROJECT_ID_REQUIRED' });
        return;
      }
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
      const all = store.listIssues(projectId);
      sendJson(res, 200, {
        items: all.slice((page - 1) * pageSize, page * pageSize),
        total: all.length,
        page,
        pageSize,
      });
    },
  },

  {
    id: '04',
    title: '匹配路径参数',
    prompt: [
      'GET /api/v1/issues/:issueId 返回 200 和该 Issue 对象（store.findIssue）。',
      'Issue 不存在时返回 404 { error: "ISSUE_NOT_FOUND" }。',
      '路径不匹配这个形状时返回 404 { error: "NOT_FOUND" }。',
      '（对应 apps/server/src/routes/issues.ts:47。Fastify 用 ":issueId" 声明，这里要自己切。）',
    ].join('\n'),
    hint: 'url.pathname.split("/") 之后比对每一段。注意开头的空字符串："/a/b".split("/") 得到 ["", "a", "b"]。',
    requests: [
      { method: 'GET', path: '/api/v1/issues/iss-hydrate' },
      { method: 'GET', path: '/api/v1/issues/iss-tax' },
      { method: 'GET', path: '/api/v1/issues/does-not-exist' },
      { method: 'GET', path: '/api/v1/nope' },
    ],
    solution(req, res, store) {
      const segments = parseUrl(req).pathname.split('/');
      // ["", "api", "v1", "issues", "<id>"]
      if (
        segments.length !== 5 ||
        segments[1] !== 'api' ||
        segments[2] !== 'v1' ||
        segments[3] !== 'issues'
      ) {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      const issue = store.findIssue(segments[4]);
      if (!issue) {
        sendJson(res, 404, { error: 'ISSUE_NOT_FOUND' });
        return;
      }
      sendJson(res, 200, issue);
    },
  },

  {
    id: '05',
    title: '读取请求 body（它是一个流）',
    prompt: [
      'POST /api/v1/echo：读取 JSON body，返回 200 { received: <解析出来的 body> }。',
      'body 不是合法 JSON（或为空）时返回 400 { error: "INVALID_JSON" }。',
      '非 POST 返回 405 { error: "METHOD_NOT_ALLOWED" }。',
    ].join('\n'),
    hint: 'req.on("data", chunk => ...) 收集分块，req.on("end", ...) 表示收完。把它包成 Promise 再 await，handler 可以是 async 函数。',
    requests: [
      { method: 'POST', path: '/api/v1/echo', body: { hello: 'world', nested: { n: 1 } } },
      { method: 'POST', path: '/api/v1/echo', rawBody: '{"broken":' },
      { method: 'POST', path: '/api/v1/echo', rawBody: '' },
      { method: 'GET', path: '/api/v1/echo' },
    ],
    async solution(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendJson(res, 400, { error: 'INVALID_JSON' });
        return;
      }
      sendJson(res, 200, { received: parsed.value });
    },
  },

  {
    id: '06',
    title: '用状态码表达不同的失败',
    prompt: [
      'PATCH /api/v1/issues/:issueId/status，body 是 { status }。',
      '成功返回 200 { id, status }。',
      'status 不在 unresolved / resolved / ignored 之内（或 body 非法）返回 400 { error: "INVALID_ISSUE_STATUS" }。',
      'Issue 不存在返回 404 { error: "ISSUE_NOT_FOUND" }。',
      '注意顺序：先校验 body，再查 Issue —— 格式错误不应该报成「找不到」。',
      '（对应 apps/server/src/routes/issues.ts:63。）',
    ].join('\n'),
    hint: 'store.updateIssueStatus 返回受影响行数，0 表示没这条记录——和 better-sqlite3 的 info.changes 一样。',
    requests: [
      { method: 'PATCH', path: '/api/v1/issues/iss-hydrate/status', body: { status: 'resolved' } },
      { method: 'PATCH', path: '/api/v1/issues/iss-hydrate/status', body: { status: 'deleted' } },
      { method: 'PATCH', path: '/api/v1/issues/nope/status', body: { status: 'resolved' } },
      { method: 'PATCH', path: '/api/v1/issues/nope/status', body: { status: 'bogus' } },
      { method: 'PATCH', path: '/api/v1/issues/iss-hydrate/status', rawBody: 'not json' },
    ],
    async solution(req, res, store) {
      const segments = parseUrl(req).pathname.split('/');
      // ["", "api", "v1", "issues", "<id>", "status"]
      if (segments.length !== 6 || segments[5] !== 'status') {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !VALID_STATUS.includes(parsed.value?.status)) {
        sendJson(res, 400, { error: 'INVALID_ISSUE_STATUS' });
        return;
      }
      const changes = store.updateIssueStatus(segments[4], parsed.value.status);
      if (changes === 0) {
        sendJson(res, 404, { error: 'ISSUE_NOT_FOUND' });
        return;
      }
      sendJson(res, 200, { id: segments[4], status: parsed.value.status });
    },
  },

  {
    id: '07',
    title: 'CORS 与预检请求',
    prompt: [
      '给所有响应加上 Access-Control-Allow-Origin: *。',
      'OPTIONS 请求（预检）直接返回 204、空 body，并带上：',
      '  Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS',
      '  Access-Control-Allow-Headers: content-type',
      '其余请求：GET /health 返回 200 { status: "ok" }，其它路径 404 { error: "NOT_FOUND" }。',
      '（对应 apps/server/src/app.ts 里 @fastify/cors 的注册。CORS 是服务端发的响应头，不是浏览器在找茬。）',
    ].join('\n'),
    hint: '204 表示「成功，但没有 body」，所以 res.end() 不要传参数。预检必须在业务逻辑之前处理掉。',
    compareHeaders: [
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
    ],
    requests: [
      { method: 'OPTIONS', path: '/api/v1/issues' },
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/whatever' },
    ],
    solution(req, res) {
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
        });
        res.end();
        return;
      }
      if (parseUrl(req).pathname === '/health') {
        sendJson(res, 200, { status: 'ok' }, cors);
        return;
      }
      sendJson(res, 404, { error: 'NOT_FOUND' }, cors);
    },
  },

  {
    id: '08',
    title: '把不可信的查询参数夹进合法区间',
    prompt: [
      'GET /api/v1/issues?projectId=demo-project&page=&pageSize=',
      '返回 200 { page, pageSize, count }，count 是实际返回的条数。',
      '规则：page 默认 1、最小 1、最大 1000000；pageSize 默认 25、最小 1、最大 100。',
      '小数向下取整；无法转成数字时用默认值。',
      '（对应 apps/server/src/routes/issues.ts:16 的 positiveInteger。',
      '不夹紧的后果：pageSize=999999 会让一个请求拖垮数据库，负数会变成非法 LIMIT。）',
    ].join('\n'),
    hint: 'Number("") 是 0，Number("abc") 是 NaN，Number(null) 是 0 —— 这三种要区分开。先判 Number.isFinite，再 Math.max(最小, Math.min(最大, Math.floor(n)))。',
    requests: [
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project' },
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project&pageSize=-5' },
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project&pageSize=999999' },
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project&pageSize=abc' },
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project&pageSize=3.7' },
      { method: 'GET', path: '/api/v1/issues?projectId=demo-project&page=0&pageSize=2' },
    ],
    solution(req, res, store) {
      const url = parseUrl(req);
      const page = positiveInteger(url.searchParams.get('page'), 1, 1_000_000);
      const pageSize = positiveInteger(url.searchParams.get('pageSize'), 25, 100);
      const all = store.listIssues(url.searchParams.get('projectId') ?? '');
      const items = all.slice((page - 1) * pageSize, page * pageSize);
      sendJson(res, 200, { page, pageSize, count: items.length });
    },
  },

  {
    id: '09',
    title: '校验 body 的结构（手写一个迷你 Zod）',
    prompt: [
      'POST /api/v1/envelopes，校验 body 的形状：',
      '  dsnKey  必须是非空字符串',
      '  events  必须是非空数组',
      '  每个 event 必须有非空字符串的 eventId、projectId、message',
      '全部通过返回 202 { accepted: <events 条数> }。',
      '不通过返回 400 { error: "INVALID_ENVELOPE", details: [<错误路径数组>] }。',
      'details 要列出「所有」错误，按发现顺序；路径写法：dsnKey、events、events.0.eventId。',
      '（对应 routes/events.ts:12 的 envelopeSchema.safeParse + error.flatten()。',
      'TypeScript 的类型编译后就没了，网络来的 JSON 在运行时是 unknown —— 这就是 Zod 存在的理由。）',
    ].join('\n'),
    hint: '收集错误而不是遇到第一个就返回，用户才能一次看到全部问题。判断非空字符串：typeof v === "string" && v.length > 0。',
    requests: [
      {
        method: 'POST',
        path: '/api/v1/envelopes',
        body: {
          dsnKey: 'demo-dsn-key',
          events: [{ eventId: 'evt-a', projectId: 'demo-project', message: 'boom' }],
        },
      },
      { method: 'POST', path: '/api/v1/envelopes', body: { events: [] } },
      {
        method: 'POST',
        path: '/api/v1/envelopes',
        body: {
          dsnKey: 'demo-dsn-key',
          events: [
            { eventId: 'evt-a', projectId: 'demo-project', message: 'ok' },
            { projectId: 'demo-project' },
          ],
        },
      },
      { method: 'POST', path: '/api/v1/envelopes', body: { dsnKey: '', events: 'nope' } },
      { method: 'POST', path: '/api/v1/envelopes', rawBody: 'xxx' },
    ],
    async solution(req, res) {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendJson(res, 400, { error: 'INVALID_ENVELOPE', details: ['body'] });
        return;
      }
      const body = parsed.value;
      const details = [];
      const isText = (value) => typeof value === 'string' && value.length > 0;
      if (!isText(body?.dsnKey)) details.push('dsnKey');
      if (!Array.isArray(body?.events) || body.events.length === 0) {
        details.push('events');
      } else {
        body.events.forEach((event, index) => {
          for (const field of ['eventId', 'projectId', 'message']) {
            if (!isText(event?.[field])) details.push(`events.${index}.${field}`);
          }
        });
      }
      if (details.length > 0) {
        sendJson(res, 400, { error: 'INVALID_ENVELOPE', details });
        return;
      }
      sendJson(res, 202, { accepted: body.events.length });
    },
  },

  {
    id: '10',
    title: '入库前脱敏',
    prompt: [
      'POST /api/v1/redact：读取 JSON body，返回 200 { clean: <脱敏后的 body> }。',
      '规则：',
      '  1. 键名匹配 /authorization|cookie|password|passwd|secret|token|api[-_]?key/i 的，值整个换成 "[REDACTED]"',
      '  2. 键名是 url / uri / href / referrer / pageUrl / requestUrl（大小写不敏感）且值是字符串的，删掉 query 和 hash',
      '  3. 数组和嵌套对象要递归处理',
      '  4. 递归深度超过 8 层返回字符串 "[Max depth]"',
      '（对应 packages/shared/src/redaction.ts。',
      '为什么服务端还要再脱敏一次：SDK 的 beforeSend 跑在用户浏览器里，那是攻击者能改的地方。）',
    ].join('\n'),
    hint: '递归函数带一个 depth 参数，每层 +1。删 query 用 new URL(值, "http://tracepilot.local") 再把 search 和 hash 置空。',
    requests: [
      {
        method: 'POST',
        path: '/api/v1/redact',
        body: {
          authorization: 'Bearer secret-value',
          pageUrl: 'https://shop.test/checkout?token=abc#top',
          user: { id: 'u1', apiKey: 'k-123', Password: 'hunter2' },
          events: [
            { url: '/cart?coupon=X', message: 'fine' },
            { cookie: 'sid=1', nested: { SECRET: 'x', keep: 42 } },
          ],
          keep: [1, 2, { alsoKeep: true }],
        },
      },
      {
        method: 'POST',
        path: '/api/v1/redact',
        body: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'deep' } } } } } } } } } },
      },
    ],
    async solution(req, res) {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendJson(res, 400, { error: 'INVALID_JSON' });
        return;
      }
      sendJson(res, 200, { clean: redact(parsed.value) });
    },
  },

  {
    id: '11',
    title: '幂等：同一批事件重发不能重复入库',
    prompt: [
      'POST /api/v1/ingest，body 是 { events: [{ eventId, issueId, userId, message }] }。',
      '逐条处理：store.hasEvent(eventId) 为真说明已经收过，计入 duplicates 并跳过；',
      '否则 store.insertEvent(event) 并计入 accepted。',
      '返回 202 { accepted, duplicates }。',
      '（对应 services/events.ts 的 eventId 去重。',
      '浏览器网络不稳会重发同一批次，没有幂等键的话计数会越报越高。）',
    ].join('\n'),
    hint: '先判重再插入。store 每道题都是全新的，初始已有 evt-0001 到 evt-0007。',
    requests: [
      {
        method: 'POST',
        path: '/api/v1/ingest',
        body: {
          events: [
            { eventId: 'evt-new-1', issueId: 'iss-hydrate', userId: 'user-1', message: 'a' },
            { eventId: 'evt-0001', issueId: 'iss-hydrate', userId: 'user-1', message: 'dup' },
          ],
        },
      },
      {
        method: 'POST',
        path: '/api/v1/ingest',
        body: {
          events: [
            { eventId: 'evt-0002', issueId: 'iss-hydrate', userId: 'user-2', message: 'dup' },
            { eventId: 'evt-0003', issueId: 'iss-promotion', userId: 'user-3', message: 'dup' },
          ],
        },
      },
    ],
    async solution(req, res, store) {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendJson(res, 400, { error: 'INVALID_JSON' });
        return;
      }
      let accepted = 0;
      let duplicates = 0;
      for (const event of parsed.value.events ?? []) {
        if (store.hasEvent(event.eventId)) {
          duplicates += 1;
          continue;
        }
        store.insertEvent(event);
        accepted += 1;
      }
      sendJson(res, 202, { accepted, duplicates });
    },
  },

  {
    id: '12',
    title: '把前面全部拼起来：真正的接入端点',
    prompt: [
      'POST /api/v1/envelopes，body 是 { dsnKey, events: [{ eventId, projectId, issueId, userId, message }] }。',
      '按顺序做六件事：',
      '  1. body 不是合法 JSON → 400 { error: "INVALID_ENVELOPE" }',
      '  2. dsnKey 查不到项目（store.findProjectByDsn）→ 403 { error: "INVALID_DSN" }',
      '  3. 某条事件的 projectId 与该项目不符 → 403 { error: "PROJECT_DSN_MISMATCH" }（整批拒绝，不部分写入）',
      '  4. eventId 已存在 → duplicates += 1 并跳过',
      '  5. 否则：先用 store.isFirstEventForUser(issueId, userId) 判定，再 insertEvent，',
      '     最后 store.bumpIssueCounters(issueId, 是否该用户首次)',
      '  6. 返回 202 { accepted, duplicates, issueIds }，issueIds 是本批次涉及的去重 issueId 数组（按首次出现顺序，排除 null）',
      '',
      '⚠️ 第 5 步的顺序是这道题的核心：判定必须在插入「之前」。',
      '插入之后再判，会查到刚写进去的那一行，user_count 永远是 0。',
      '（对应 routes/events.ts + services/events.ts。TracePilot 第一版就写反了。）',
    ].join('\n'),
    hint: '第 3 步要求整批拒绝，所以先把所有事件的 projectId 检查一遍，再开始写入 —— 这就是「事务边界」的手工版本。',
    requests: [
      {
        method: 'POST',
        path: '/api/v1/envelopes',
        body: {
          dsnKey: 'demo-dsn-key',
          events: [
            {
              eventId: 'e1',
              projectId: 'demo-project',
              issueId: 'iss-hydrate',
              userId: 'user-99',
              message: 'a',
            },
            {
              eventId: 'e2',
              projectId: 'demo-project',
              issueId: 'iss-hydrate',
              userId: 'user-99',
              message: 'b',
            },
            {
              eventId: 'evt-0001',
              projectId: 'demo-project',
              issueId: 'iss-hydrate',
              userId: 'user-1',
              message: 'dup',
            },
            {
              eventId: 'e3',
              projectId: 'demo-project',
              issueId: 'iss-tax',
              userId: 'user-50',
              message: 'c',
            },
          ],
        },
      },
      { method: 'POST', path: '/api/v1/envelopes', body: { dsnKey: 'nope', events: [] } },
      {
        method: 'POST',
        path: '/api/v1/envelopes',
        body: {
          dsnKey: 'demo-dsn-key',
          events: [
            {
              eventId: 'x1',
              projectId: 'demo-project',
              issueId: 'iss-hydrate',
              userId: 'u',
              message: 'a',
            },
            {
              eventId: 'x2',
              projectId: 'mobile-web',
              issueId: 'iss-offline',
              userId: 'u',
              message: 'b',
            },
          ],
        },
      },
      { method: 'POST', path: '/api/v1/envelopes', rawBody: 'broken' },
    ],
    // 这道题还要检查写入后的数据状态，不只看响应。
    inspectStore: true,
    async solution(req, res, store) {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendJson(res, 400, { error: 'INVALID_ENVELOPE' });
        return;
      }
      const { dsnKey, events = [] } = parsed.value;
      const project = store.findProjectByDsn(dsnKey);
      if (!project) {
        sendJson(res, 403, { error: 'INVALID_DSN' });
        return;
      }
      // 整批校验放在任何写入之前：这就是事务「要么全成功要么全回滚」的手工版本。
      if (events.some((event) => event.projectId !== project.id)) {
        sendJson(res, 403, { error: 'PROJECT_DSN_MISMATCH' });
        return;
      }
      let accepted = 0;
      let duplicates = 0;
      const issueIds = [];
      for (const event of events) {
        if (store.hasEvent(event.eventId)) {
          duplicates += 1;
          continue;
        }
        const issueId = event.issueId ?? null;
        // 关键顺序：先判定，后插入。
        const firstSeenForUser = issueId
          ? store.isFirstEventForUser(issueId, event.userId ?? null)
          : false;
        store.insertEvent(event);
        if (issueId) {
          store.bumpIssueCounters(issueId, firstSeenForUser);
          if (!issueIds.includes(issueId)) issueIds.push(issueId);
        }
        accepted += 1;
      }
      sendJson(res, 202, { accepted, duplicates, issueIds });
    },
  },
];

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

/** 递归排序对象的键，让 {a,b} 和 {b,a} 判为相同。数组顺序仍然敏感。 */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

function same(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/**
 * 启动一个真实的 HTTP server 跑这个 handler，依次发请求，收集响应。
 *
 * listen(0) 表示「让操作系统随便挑一个空闲端口」，这样并发跑测试不会撞端口。
 */
async function runAgainst(handler, exercise) {
  const store = createStore();
  const server = createServer((req, res) => {
    // 包一层，handler 抛异常时返回 500 而不是让整个进程挂掉。
    // 这正是 app.ts 里 setErrorHandler 的作用。
    Promise.resolve()
      .then(() => handler(req, res, store))
      .catch((error) => {
        if (res.headersSent) return;
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'HANDLER_THREW', message: error.message }));
      });
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const responses = [];

  try {
    for (const request of exercise.requests) {
      const init = { method: request.method };
      if (request.rawBody !== undefined) {
        init.body = request.rawBody;
        init.headers = { 'Content-Type': 'application/json' };
      } else if (request.body !== undefined) {
        init.body = JSON.stringify(request.body);
        init.headers = { 'Content-Type': 'application/json' };
      }
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, init);
      const text = await response.text();
      let body;
      try {
        body = text.length === 0 ? null : JSON.parse(text);
      } catch {
        body = { __rawText: text };
      }
      const picked = {};
      for (const name of exercise.compareHeaders ?? []) {
        picked[name] = response.headers.get(name);
      }
      responses.push({ status: response.status, headers: picked, body });
    }
  } finally {
    await new Promise((done) => server.close(done));
  }

  return { responses, store: exercise.inspectStore ? store.snapshot() : null };
}

function describeRequest(request) {
  const payload =
    request.rawBody !== undefined
      ? ` <原始 body: ${JSON.stringify(request.rawBody)}>`
      : request.body !== undefined
        ? ` ${JSON.stringify(request.body)}`
        : '';
  return `${request.method} ${request.path}${payload}`;
}

async function checkOne(exercise) {
  const file = resolve(answersDir, `${exercise.id}.mjs`);
  if (!existsSync(file)) return { id: exercise.id, state: 'todo' };

  let handler;
  try {
    const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    handler = module.default;
    if (typeof handler !== 'function') {
      return { id: exercise.id, state: 'error', message: '答案文件必须 export default 一个函数' };
    }
  } catch (error) {
    return { id: exercise.id, state: 'error', message: `加载失败：${error.message}` };
  }

  let actual;
  let expected;
  try {
    actual = await runAgainst(handler, exercise);
    expected = await runAgainst(exercise.solution, exercise);
  } catch (error) {
    return { id: exercise.id, state: 'error', message: `运行失败：${error.message}` };
  }

  for (const [index, request] of exercise.requests.entries()) {
    const got = actual.responses[index];
    const want = expected.responses[index];
    if (!same(got, want)) {
      return {
        id: exercise.id,
        state: 'fail',
        request: describeRequest(request),
        got,
        want,
      };
    }
  }

  if (exercise.inspectStore && !same(actual.store, expected.store)) {
    return {
      id: exercise.id,
      state: 'fail',
      request: '（响应都对，但写入数据库的结果不对——多半是计数或判定顺序的问题）',
      got: actual.store.issues.filter((i) => i.id === 'iss-hydrate' || i.id === 'iss-tax'),
      want: expected.store.issues.filter((i) => i.id === 'iss-hydrate' || i.id === 'iss-tax'),
    };
  }

  return { id: exercise.id, state: 'pass' };
}

function report(exercise, result) {
  const label = `${exercise.id}. ${exercise.title}`;
  if (result.state === 'pass') return `✅ ${label}`;
  if (result.state === 'todo') return `⬜ ${label}  —— 还没写 answers/${exercise.id}.mjs`;
  if (result.state === 'error') return `💥 ${label}\n   ${result.message}`;
  return [
    `❌ ${label}`,
    `   请求：${result.request}`,
    `   你的响应：${JSON.stringify(result.got)}`,
    `   期望响应：${JSON.stringify(result.want)}`,
  ].join('\n');
}

async function main() {
  const only = process.argv[2];
  const targets = only ? EXERCISES.filter((item) => item.id === only) : EXERCISES;

  if (targets.length === 0) {
    console.error(`没有编号为 ${only} 的练习。可用编号：${EXERCISES.map((e) => e.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // 只查一道时，顺便把题面打印出来，不用来回翻教程。
  if (only && targets.length === 1) {
    console.log(`\n【${targets[0].id}】${targets[0].title}\n`);
    console.log(targets[0].prompt);
    console.log(`\n提示：${targets[0].hint}\n`);
    console.log('─'.repeat(72));
  }

  let passed = 0;
  let failed = 0;
  for (const exercise of targets) {
    const result = await checkOne(exercise);
    console.log(report(exercise, result));
    if (result.state === 'pass') passed += 1;
    if (result.state === 'fail' || result.state === 'error') failed += 1;
  }

  console.log(`\n通过 ${passed} / ${targets.length}`);
  if (failed > 0) process.exitCode = 1;
}

// 只有直接运行这个文件时才判分；被 serve.mjs 之类 import 时只提供 EXERCISES。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
