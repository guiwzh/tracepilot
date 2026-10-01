import { randomUUID } from 'node:crypto';
import {
  redactPayload,
  redactSensitive,
  redactStack,
  stripUrlQuery,
  type EventEnvelope,
  type MonitorEvent,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import {
  issueFingerprint,
  legacyFingerprint,
  normalizeDisplayTitle,
  requestOutcome,
} from '../lib/fingerprint';
import { resolveStack, type ResolvedStack } from './sourcemaps';

/** 一次接入的结果，原样作为 202 响应返回给 SDK。 */
export interface IngestResult {
  /** 新写入的事件数。 */
  accepted: number;
  /** 已经收过、被跳过的事件数（重试或重复送达）。 */
  duplicates: number;
  /** 以同一个 metricId 再次上报的 Web Vitals 样本数：值更新时覆盖，迟到的旧值被忽略。 */
  metricUpdates: number;
  /** 这批事件涉及的 Issue。 */
  issueIds: string[];
}

export interface IngestOutcome {
  result: IngestResult;
  /**
   * Source Map 还原出错的事件数。还原是附加信息：出错的事件照常入库，按压缩堆栈聚合，
   * 只是少了原始栈；这个数只用来记日志。
   */
  symbolicationFailures: number;
}

/** 接入被拒绝的原因。路由据此返回 403；其余错误按服务端问题处理。 */
export class IngestError extends Error {
  constructor(
    /** INVALID_DSN：DSN Key 不存在；PROJECT_DSN_MISMATCH：事件声明的项目与 Key 不符。 */
    readonly code: 'INVALID_DSN' | 'PROJECT_DSN_MISMATCH',
  ) {
    super(code);
  }
}

/**
 * 设备时钟与服务端相差超过这个值，才认为设备时钟不准。SDK 每次发送时写入 sentAt，它与服务端
 * 收到的时间正常只差网络耗时和几百毫秒的快速重试，远小于一分钟。
 */
const CLOCK_TOLERANCE_MS = 60_000;

/**
 * 按 sentAt 估计设备时钟的偏差：服务端收到的时间减去设备声称的发送时间。
 * 偏差在容差以内按 0 处理，不去挪动时钟正常的设备上报的时间。
 */
function clockOffset(sentAt: number, receivedAt: number): number {
  const offset = receivedAt - sentAt;
  return Math.abs(offset) > CLOCK_TOLERANCE_MS ? offset : 0;
}

/**
 * 把事件时间换算到服务端时钟。事件时间和 breadcrumb 时间都来自用户设备的时钟，而设备时钟可能
 * 差出几小时甚至几年（手动改过时间、长期没有联网校时）。不校正的话，一台时钟快一年的设备上报的
 * 错误会以明年的时间排在 Issue 列表最前面，概览的 24 小时统计也对不上趋势图。
 *
 * 平移之后仍然在未来、或不是正数（事件时间与同一信封的 sentAt 自相矛盾），以收到的时间为准。
 * breadcrumb 跟着平移同样的量，它们与错误之间的相对时间保持不变。
 */
function toServerClock(event: MonitorEvent, offset: number, receivedAt: number): MonitorEvent {
  let timestamp = event.timestamp + offset;
  if (timestamp <= 0 || timestamp > receivedAt + CLOCK_TOLERANCE_MS) timestamp = receivedAt;
  const shift = timestamp - event.timestamp;
  if (shift === 0) return event;
  return {
    ...event,
    timestamp,
    breadcrumbs: event.breadcrumbs.map((item) => ({ ...item, timestamp: item.timestamp + shift })),
  };
}

/**
 * web-vitals 为每个页面加载中的每个指标分配唯一 id；LCP/CLS/INP 的值在页面生命周期里会增长，
 * SDK 会以同一个 id 再报一次。按 id 覆盖而不是追加，否则同一次访问的多个中间值会把 p75 拉偏。
 */
function metricInstanceId(event: MonitorEvent): string | null {
  if (event.eventType !== 'performance') return null;
  const metricId = event.payload.metricId;
  return typeof metricId === 'string' && metricId.length > 0 && metricId.length <= 200
    ? metricId
    : null;
}

/**
 * 入库前的脱敏。堆栈字段不能套用通用的文本规则：它会把 "app.js?v=3:1:420)" 从问号起整段删掉，
 * 存下来的堆栈丢了行列号，上传 map 后的回填和排障 Agent 查看源码都无从还原。
 */
function redactEvent(event: MonitorEvent): MonitorEvent {
  const { payload, ...rest } = event;
  return { ...redactSensitive(rest), payload: redactPayload(payload) };
}

function eventContext(event: MonitorEvent) {
  return {
    page: { ...event.page, url: stripUrlQuery(event.page.url) },
    device: event.device,
    payload: event.payload,
    environment: event.environment,
    release: event.release,
    // 生效的采样率；旧版本 SDK 不上报，按 1（全量）处理。
    sampleRate: event.sampleRate ?? 1,
  };
}

function shouldCreateIssue(event: MonitorEvent): boolean {
  // 性能样本只进入指标流；成功网络请求只做证据，失败请求才需要形成 Issue。
  if (event.eventType === 'performance') return false;
  if (event.eventType === 'network') {
    const status = Number(event.payload.status ?? 0);
    return event.payload.success === false || status >= 400 || Boolean(event.payload.error);
  }
  return true;
}

function eventTitle(event: MonitorEvent): string {
  const payload = event.payload;
  if (event.eventType === 'network') {
    return `${String(payload.method ?? 'GET').toUpperCase()} ${stripUrlQuery(String(payload.url ?? 'request'))} → ${requestOutcome(payload)}`;
  }
  if (event.eventType === 'resource') {
    return `Resource failed: ${stripUrlQuery(String(payload.url ?? payload.tagName ?? 'unknown'))}`;
  }
  if (event.eventType === 'performance') return `${String(payload.metric ?? 'Metric')} sample`;
  return normalizeDisplayTitle(
    String(payload.message ?? payload.name ?? 'Unknown client error').slice(0, 500),
  );
}

function eventLevel(event: MonitorEvent): 'error' | 'warning' | 'info' {
  const declared = event.payload.level;
  if (declared === 'warning' || declared === 'info' || declared === 'error') return declared;
  if (event.eventType === 'performance') return 'info';
  // 业务码表示失败的请求是真实的失败（接入方的判定函数只标记真正的错误），与 5xx 同级。
  if (event.eventType === 'network' && event.payload.businessCode !== undefined) return 'error';
  // 4xx 是 warning；5xx 和拿不到响应（状态码 0：断网、超时、跨域被拦）是 error，
  // 与 SDK 默认把这两类请求判为失败的口径一致。
  const status = Number(event.payload.status ?? 0);
  if (event.eventType === 'network' && status > 0 && status < 500) return 'warning';
  return 'error';
}

/** 找到事件所属的 Release，没有就创建，返回它的 id。 */
function ensureRelease(database: TraceDatabase, event: MonitorEvent): string {
  // SDK 可能先于人工创建 Release 上线，因此接入时按版本号惰性补建记录。
  const existing = database.sqlite
    .prepare('SELECT id FROM releases WHERE project_id = ? AND version = ?')
    .get(event.projectId, event.release) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  database.sqlite
    .prepare('INSERT INTO releases (id, project_id, version, created_at) VALUES (?, ?, ?, ?)')
    .run(id, event.projectId, event.release, event.timestamp);
  return id;
}

/**
 * 把事件归到一个 Issue 上：按指纹在 issue_fingerprints 里找到 Issue 就更新它，找不到就新建
 * （这种「有则更新、无则插入」常被叫作 upsert）。成功的网络请求、性能样本不形成 Issue，返回 null。
 *
 * 指纹与 Issue 是多对一：合并 Issue、升级聚合算法之后，多个指纹指向同一个 Issue。
 * 新算法（v2）的指纹找不到时，再按旧算法（v1）算一次：升级之前建的 Issue 只登记了 v1 指纹，
 * 找到了就把 v2 指纹也登记上去，正在发生的问题不会因为算法升级突然变成新 Issue。
 * SDK 自定义的指纹不走这一步：自定义正是为了改变聚合结果，退回旧指纹会把它又并回去。
 *
 * 更新时：
 * - 出现时间取最早和最晚；事件乱序到达时，只有不早于已知最晚一次的事件才改写标题。
 * - 回归：已解决的 Issue 又发生了新事件（发生时间晚于标记解决的时间），重新打开为未解决。
 *   只看发生时间，所以解决之前就发生、只是迟到的事件（例如服务端故障期间积压在 SDK 队列里的）
 *   不会把它重新打开。已忽略的 Issue 保持忽略。
 * - SET 右边读到的都是更新之前的旧值，所以几个 CASE 判断的是同一个旧状态。
 * - 计数（event_count、user_count）从 0 起步，统一由 updateIssueCounters 在事件落库后增量累加。
 */
function resolveIssue(
  database: TraceDatabase,
  event: MonitorEvent,
  resolved: ResolvedStack | undefined,
): string | null {
  if (!shouldCreateIssue(event)) return null;
  const { fingerprint, algorithm } = issueFingerprint(event, resolved?.frames);
  const find = database.sqlite.prepare(
    'SELECT issue_id FROM issue_fingerprints WHERE project_id = ? AND fingerprint = ?',
  );
  const register = database.sqlite.prepare(
    `INSERT INTO issue_fingerprints (project_id, fingerprint, issue_id, algorithm, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let issueId = (find.get(event.projectId, fingerprint) as { issue_id: string } | undefined)
    ?.issue_id;
  if (!issueId && algorithm === 'v2') {
    issueId = (
      find.get(event.projectId, legacyFingerprint(event)) as { issue_id: string } | undefined
    )?.issue_id;
    if (issueId) register.run(event.projectId, fingerprint, issueId, algorithm, event.timestamp);
  }

  const values = { title: eventTitle(event), level: eventLevel(event), timestamp: event.timestamp };
  if (issueId) {
    database.sqlite
      .prepare(
        `UPDATE issues SET
           first_seen_at = MIN(first_seen_at, @timestamp),
           last_seen_at = MAX(last_seen_at, @timestamp),
           title = CASE WHEN @timestamp >= last_seen_at THEN @title ELSE title END,
           status = CASE WHEN status = 'resolved' AND @timestamp > COALESCE(resolved_at, 0)
             THEN 'unresolved' ELSE status END,
           resolved_at = CASE WHEN status = 'resolved' AND @timestamp > COALESCE(resolved_at, 0)
             THEN NULL ELSE resolved_at END
         WHERE id = @id`,
      )
      .run({ ...values, id: issueId });
    return issueId;
  }
  const id = randomUUID();
  // issues.fingerprint 记下建 Issue 时的指纹，供搜索和展示；归并只查 issue_fingerprints。
  database.sqlite
    .prepare(
      `INSERT INTO issues (id, project_id, fingerprint, title, status, level, first_seen_at, last_seen_at)
       VALUES (@id, @projectId, @fingerprint, @title, 'unresolved', @level, @timestamp, @timestamp)`,
    )
    .run({ ...values, id, projectId: event.projectId, fingerprint });
  register.run(event.projectId, fingerprint, id, algorithm, event.timestamp);
  return id;
}

function isFirstEventForUser(
  database: TraceDatabase,
  issueId: string,
  userId: string | null,
): boolean {
  // 必须在插入本条事件之前判定，否则永远会查到刚写入的这一行，user_count 将恒为 0。
  // 查询走 (issue_id, user_id) 索引，代价与 Issue 已有事件数无关。
  if (userId === null) return false;
  return !database.sqlite
    .prepare('SELECT 1 FROM events WHERE issue_id = ? AND user_id = ? LIMIT 1')
    .get(issueId, userId);
}

function updateIssueCounters(
  database: TraceDatabase,
  issueId: string,
  firstSeenForUser: boolean,
): void {
  // 幂等已由前置的 eventId 去重保证（重复批次在插入前就 continue 了），因此这里增量 +1。
  // 早期实现每条事件都用 COUNT(*) 重新派生计数，单次写入退化为 O(Issue 内事件数)，
  // 单 Issue 累积到一万条时单批接入 P50 从 1.79 ms 劣化到 12.88 ms。
  database.sqlite
    .prepare(
      'UPDATE issues SET event_count = event_count + 1, user_count = user_count + ? WHERE id = ?',
    )
    .run(firstSeenForUser ? 1 : 0, issueId);
}

/** 信封里的一个事件，经过规范化之后、入库之前。 */
interface PreparedEvent {
  /** 换算到服务端时钟、尚未脱敏的事件；Web Vitals 覆盖时要用它重新脱敏。 */
  raw: MonitorEvent;
  /** 脱敏后的事件，入库和聚合都用它。 */
  event: MonitorEvent;
  rowId: string;
  metricId: string | null;
  stack: string | null;
  /** Source Map 还原的结果；没有堆栈、重复送达或还原出错时没有。 */
  resolved?: ResolvedStack;
}

/**
 * 接入一个信封（SDK 一次上报的一批事件），分三段：
 *
 *   1. 规范化（同步）：确认每个事件都属于 DSN Key 对应的项目，把时间换算到服务端时钟，
 *      算出行 id，脱敏。项目不符时整个信封被拒绝，什么都还没写。
 *   2. 还原（异步，在事务之外）：对带堆栈、尚未入库的事件做 Source Map 还原。读 map 文件是异步的，
 *      而 SQLite 事务必须同步执行完，所以还原放在事务之前。出错只计数，事件照常入库。
 *   3. 入库（同步，一个事务）：幂等检查（Web Vitals 例外：按指标 id 覆盖为更新的值），关联或创建 Release，
 *      用还原后的栈帧算指纹、归入 Issue，写入事件，更新 Issue 的事件数和影响用户数。
 *
 * 先还原、再聚合，和 Sentry 等产品的顺序一致：聚合看的是源码位置，同一个 bug 不会因为重新构建
 * 换了压缩后的函数名和列号就变成新的 Issue。这要求 map 在流量到来之前上传（构建时上传）；
 * 事后补传的 map 只回填 original_stack，不会重新聚合已经入库的事件。
 *
 * 「幂等」指同一个请求执行一次和执行多次效果相同。浏览器会重试、beacon 和普通请求可能重复送达，
 * 所以接入必须幂等，否则同一个错误会被数成好几次。第 2 段之前先查一次重复，重复送达的事件不再还原；
 * 第 3 段在事务里再查一次，两个并发请求送来同一个事件时也只写入一次。
 *
 * 整批写入包在一个事务里：所有写操作要么全部生效，要么全部撤销，一批写入也只需落盘一次。
 */
export async function ingestEnvelope(
  database: TraceDatabase,
  envelope: EventEnvelope,
  receivedAt = Date.now(),
): Promise<IngestOutcome> {
  // 先用公开 DSN Key 找项目；后面还会校验每个事件声明的 projectId。
  const project = database.sqlite
    .prepare('SELECT id FROM projects WHERE dsn_key = ?')
    .get(envelope.dsnKey) as { id: string } | undefined;
  if (!project) throw new IngestError('INVALID_DSN');
  const offset = clockOffset(envelope.sentAt, receivedAt);

  // 1. 规范化
  const prepared: PreparedEvent[] = envelope.events.map((reported) => {
    if (reported.projectId !== project.id) throw new IngestError('PROJECT_DSN_MISMATCH');
    const raw = toServerClock(reported, offset, receivedAt);
    const metricId = metricInstanceId(raw);
    // SDK 虽然已经脱敏过，Server 仍把客户端数据视为不可信并再做一遍：
    // 遮蔽 token、password 等字段，去掉 URL 里的查询参数。
    const event = redactEvent(raw);
    return {
      raw,
      event,
      metricId,
      // 指标样本的行 id 由 metricId 派生，普通事件沿用 SDK 生成的 eventId。
      rowId: metricId ? `metric:${project.id}:${metricId}` : raw.eventId,
      stack: typeof event.payload.stack === 'string' ? event.payload.stack : null,
    };
  });

  // 2. 还原
  const findRelease = database.sqlite.prepare(
    'SELECT id FROM releases WHERE project_id = ? AND version = ?',
  );
  const stored = database.sqlite.prepare('SELECT 1 FROM events WHERE id = ?');
  let symbolicationFailures = 0;
  for (const item of prepared) {
    if (!item.stack || item.metricId || stored.get(item.rowId)) continue;
    // 版本还没登记时没有任何 map，只解析栈帧（聚合仍要用它挑出应用自己的帧）。
    const release = findRelease.get(project.id, item.event.release) as { id: string } | undefined;
    try {
      item.resolved = await resolveStack(database, release?.id ?? null, item.stack);
    } catch {
      symbolicationFailures += 1;
    }
  }

  // 3. 入库
  let accepted = 0;
  let duplicates = 0;
  let metricUpdates = 0;
  const issueIds = new Set<string>();
  // transaction() 把回调包装成一个事务函数：调用时先 BEGIN，回调正常结束则 COMMIT（提交生效），
  // 回调里任何地方抛错则 ROLLBACK（全部撤销），错误继续向外抛给路由处理。
  const ingest = database.sqlite.transaction(() => {
    for (const { raw, event, rowId, metricId, stack, resolved } of prepared) {
      const existing = database.sqlite
        .prepare('SELECT created_at FROM events WHERE id = ?')
        .get(rowId) as { created_at: number } | undefined;
      if (existing && metricId) {
        // 以采集时间为准做「后写者胜」：重试后才送达的旧值晚到时，不能覆盖已经入库的新值。
        if (raw.timestamp >= existing.created_at) {
          database.sqlite
            .prepare('UPDATE events SET context_json = ?, created_at = ? WHERE id = ?')
            .run(JSON.stringify(eventContext(event)), raw.timestamp, rowId);
        }
        metricUpdates += 1;
        continue;
      }
      if (existing) {
        // eventId 是幂等键，浏览器重试同一批次、或 beacon 与在途请求重复送达时不会重复写入。
        duplicates += 1;
        continue;
      }

      const releaseId = ensureRelease(database, event);
      const issueId = resolveIssue(database, event, resolved);
      const userId = event.user?.id ?? event.user?.anonymousId ?? null;
      // 必须在事件落库之前判定，否则会查到本条刚写入的记录。
      const firstSeenForUser = issueId ? isFirstEventForUser(database, issueId, userId) : false;

      database.sqlite
        .prepare(
          `INSERT INTO events (id, issue_id, release_id, type, message, stack, original_stack, page_url,
             user_id, context_json, breadcrumbs_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rowId,
          issueId,
          releaseId,
          event.eventType,
          eventTitle(event),
          stack,
          // 还原后的堆栈同样按栈帧规则脱敏：只删帧里的查询参数，保留行列号。
          resolved?.text ? redactStack(resolved.text) : null,
          stripUrlQuery(event.page.url),
          userId,
          JSON.stringify(eventContext(event)),
          JSON.stringify(event.breadcrumbs),
          event.timestamp,
        );
      if (issueId) {
        updateIssueCounters(database, issueId, firstSeenForUser);
        issueIds.add(issueId);
      }
      accepted += 1;
    }
  });
  // 真正执行事务。计数变量在回调里被累加，回调抛错时它们已经无关紧要（错误会一路抛出）。
  ingest();
  return {
    result: { accepted, duplicates, metricUpdates, issueIds: [...issueIds] },
    symbolicationFailures,
  };
}
