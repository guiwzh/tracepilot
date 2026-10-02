import { randomUUID } from 'node:crypto';
import type {
  AlertChannel,
  AlertDelivery,
  AlertRule,
  AlertTestResult,
  AlertTrigger,
  IssueActivity,
  IssueLevel,
  IssueStatus,
  UpdateAlertRule,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson } from '../lib/json';
import {
  maskChannelUrl,
  sendToChannel,
  type AlertMessage,
  type SendOptions,
} from './alertChannels';
import {
  investigationUrl,
  startAutoInvestigation,
  type InvestigationStarter,
} from './autoInvestigation';

/**
 * 告警：规则的增删改查，以及把 Issue 的生命周期变化变成通知的分发器。
 *
 *   接入（同一个事务）           分发器（事务之外，每 5 秒一轮，接入后立即补一轮）
 *   Issue 新建 / 回归 / 恶化 ──► issue_activity（待处理）──► 匹配规则 ──► alert_deliveries ──► 发送，失败退避重试
 *                                                          （静默、去重、每小时上限 → suppressed）
 *
 * 这是「事务性发件箱」（transactional outbox）：要发的通知先和业务数据一起落库，再由后台把它发出去。
 * 好处是 Issue 变了就一定会有通知（进程崩溃也不丢，重启后接着发），而发通知的网络请求不拖慢接入、
 * 也不在数据库事务里等待。代价是通知会晚几秒，以及至少一次投递：发送成功但还没来得及记下就崩溃了，
 * 重启后会再发一次——接收方可以按 x-tracepilot-delivery 去重。
 */

export const ALERT_LIMITS = {
  /** 待处理的活动记录超过这么久就不再告警：告警说的是「现在」。别的进程（种子脚本）写入的旧记录也因此不会告警。 */
  staleAfterMs: 60 * 60_000,
  /** 一条规则每小时最多发出的通知数。一次发布引入几十个新 Issue 时不至于刷屏，超出的记为 rate_limited。 */
  perRulePerHour: 20,
  /** 一条通知最多尝试的次数。 */
  maxAttempts: 5,
  pollIntervalMs: 5_000,
  /** 一个项目最多的规则数。 */
  rulesPerProject: 20,
};

/** 第 n 次失败之后等多久再试：30 秒起，每次翻倍，最多 30 分钟。 */
export function retryDelay(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

const LEVEL_RANK: Record<IssueLevel, number> = { info: 0, warning: 1, error: 2 };
const TRIGGER_OF: Partial<Record<IssueActivity['kind'], AlertTrigger>> = {
  created: 'new_issue',
  regressed: 'regression',
  escalating: 'escalating',
};

interface RuleRow {
  id: string;
  project_id: string;
  name: string;
  enabled: number;
  triggers_json: string;
  min_level: IssueLevel;
  channel_json: string;
  interval_minutes: number;
  muted_until: number | null;
  auto_investigate: number;
  created_at: number;
  updated_at: number;
}

function channelOf(row: RuleRow): AlertChannel {
  return JSON.parse(row.channel_json) as AlertChannel;
}

function mapRule(row: RuleRow): AlertRule {
  const channel = channelOf(row);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    enabled: row.enabled === 1,
    triggers: parseJson<AlertTrigger[]>(row.triggers_json, []),
    minLevel: row.min_level,
    channel: {
      type: channel.type,
      target: maskChannelUrl(channel.url),
      signed: 'secret' in channel && Boolean(channel.secret),
    },
    intervalMinutes: row.interval_minutes,
    mutedUntil: row.muted_until,
    autoInvestigate: row.auto_investigate === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ruleRow(database: TraceDatabase, ruleId: string): RuleRow | undefined {
  return database.sqlite.prepare('SELECT * FROM alert_rules WHERE id = ?').get(ruleId) as
    RuleRow | undefined;
}

export function listAlertRules(database: TraceDatabase, projectId: string): AlertRule[] {
  return (
    database.sqlite
      .prepare('SELECT * FROM alert_rules WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as RuleRow[]
  ).map(mapRule);
}

export class AlertRuleError extends Error {
  constructor(readonly code: 'TOO_MANY_RULES') {
    super(code);
  }
}

export function createAlertRule(
  database: TraceDatabase,
  projectId: string,
  input: {
    name: string;
    triggers: AlertTrigger[];
    minLevel: IssueLevel;
    intervalMinutes: number;
    channel: AlertChannel;
    autoInvestigate?: boolean;
  },
  now = Date.now(),
): AlertRule {
  const count = database.sqlite
    .prepare('SELECT COUNT(*) AS count FROM alert_rules WHERE project_id = ?')
    .get(projectId) as { count: number };
  if (count.count >= ALERT_LIMITS.rulesPerProject) throw new AlertRuleError('TOO_MANY_RULES');
  const id = randomUUID();
  database.sqlite
    .prepare(
      `INSERT INTO alert_rules (id, project_id, name, enabled, triggers_json, min_level, channel_json,
         interval_minutes, muted_until, auto_investigate, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      input.name,
      JSON.stringify([...new Set(input.triggers)]),
      input.minLevel,
      JSON.stringify(input.channel),
      input.intervalMinutes,
      input.autoInvestigate ? 1 : 0,
      now,
      now,
    );
  return mapRule(ruleRow(database, id)!);
}

/** 部分修改；返回 null 表示没有这条规则。 */
export function updateAlertRule(
  database: TraceDatabase,
  ruleId: string,
  patch: UpdateAlertRule,
  now = Date.now(),
): AlertRule | null {
  const current = ruleRow(database, ruleId);
  if (!current) return null;
  database.sqlite
    .prepare(
      `UPDATE alert_rules SET name = ?, enabled = ?, triggers_json = ?, min_level = ?,
         interval_minutes = ?, muted_until = ?, auto_investigate = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      patch.name ?? current.name,
      patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
      patch.triggers ? JSON.stringify([...new Set(patch.triggers)]) : current.triggers_json,
      patch.minLevel ?? current.min_level,
      patch.intervalMinutes ?? current.interval_minutes,
      patch.mutedUntil === undefined ? current.muted_until : patch.mutedUntil,
      patch.autoInvestigate === undefined
        ? current.auto_investigate
        : patch.autoInvestigate
          ? 1
          : 0,
      now,
      ruleId,
    );
  return mapRule(ruleRow(database, ruleId)!);
}

export function deleteAlertRule(database: TraceDatabase, ruleId: string): boolean {
  return database.sqlite.prepare('DELETE FROM alert_rules WHERE id = ?').run(ruleId).changes > 0;
}

interface DeliveryRow {
  id: string;
  rule_id: string;
  rule_name: string;
  issue_id: string | null;
  trigger_type: AlertDelivery['trigger'];
  status: AlertDelivery['status'];
  reason: string | null;
  attempts: number;
  investigation_id: string | null;
  investigation_note: string | null;
  payload_json: string;
  created_at: number;
  sent_at: number | null;
}

/** 最近的通知，新的在前。 */
export function listAlertDeliveries(
  database: TraceDatabase,
  projectId: string,
  limit = 20,
): AlertDelivery[] {
  const rows = database.sqlite
    .prepare(
      `SELECT d.*, r.name AS rule_name FROM alert_deliveries d JOIN alert_rules r ON r.id = d.rule_id
       WHERE d.project_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    )
    .all(projectId, limit) as DeliveryRow[];
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    issueId: row.issue_id,
    issueTitle: parseJson<Partial<AlertMessage>>(row.payload_json, {}).issue?.title ?? '',
    trigger: row.trigger_type,
    status: row.status,
    reason: row.reason,
    attempts: row.attempts,
    investigationId: row.investigation_id,
    investigationNote: row.investigation_note,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }));
}

/** 告警里一句话的「为什么」。 */
function describe(
  kind: IssueActivity['kind'],
  data: Record<string, unknown>,
  release: string | null,
) {
  if (kind === 'created') {
    return `First seen${data.release ? ` in release ${String(data.release)}` : release ? ` in release ${release}` : ''}.`;
  }
  if (kind === 'regressed') {
    return `Seen again${data.release ? ` in release ${String(data.release)}` : ''} after it was marked resolved.`;
  }
  const recent = Number(data.recentEvents);
  const baseline = Number(data.baselinePerHour);
  return `${recent} events in the last hour, against a usual ${baseline} per hour (threshold ${String(data.threshold)}).${data.reopened ? ' It was ignored until escalating and has been reopened.' : ''}`;
}

interface PendingActivity {
  id: number;
  project_id: string;
  issue_id: string;
  kind: IssueActivity['kind'];
  data_json: string;
  created_at: number;
}

/** 告警消息里 Issue 的快照：发出时的标题、级别、计数和最近的版本。 */
interface IssueSnapshot {
  project_name: string;
  title: string;
  level: IssueLevel;
  status: IssueStatus;
  event_count: number;
  user_count: number;
  first_seen_at: number;
  last_seen_at: number;
  latest_release: string | null;
}

export interface DispatcherOptions extends SendOptions {
  /** 工作台的地址，告警里的链接指向 <dashboardUrl>/projects/<项目>/issues/<Issue>。 */
  dashboardUrl: string;
  now?: () => number;
  /** 一轮处理出错时（例如数据库已关闭）的回调；分发器自己不抛错，不能让后台任务打断进程。 */
  onError?: (error: unknown) => void;
  /** 规则要求「告警时顺带调查」时用它发起调查（services/autoInvestigation.ts）；没有时不发起。 */
  investigations?: InvestigationStarter;
}

/** 分发器用到的语句，构造时编译一次：每批接入之后都要跑一轮，每次重新 prepare 的开销比查询本身还大。 */
function dispatcherStatements(sqlite: TraceDatabase['sqlite']) {
  return {
    pending: sqlite.prepare(
      `SELECT id, project_id, issue_id, kind, data_json, created_at FROM issue_activity
       WHERE processed = 0 ORDER BY id LIMIT 200`,
    ),
    // 取出的是待处理记录里 id 最小的一批（同一个事务里没有别人在写），按 id 一次标记完。
    markProcessed: sqlite.prepare(
      'UPDATE issue_activity SET processed = 1 WHERE processed = 0 AND id <= ?',
    ),
    rules: sqlite.prepare('SELECT * FROM alert_rules WHERE project_id = ? AND enabled = 1'),
    snapshot: sqlite.prepare(
      `SELECT p.name AS project_name, i.title, i.level, i.status, i.event_count, i.user_count,
         i.first_seen_at, i.last_seen_at,
         (SELECT r.version FROM events e JOIN releases r ON r.id = e.release_id
          WHERE e.issue_id = i.id ORDER BY e.created_at DESC LIMIT 1) AS latest_release
       FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ?`,
    ),
    recentForIssue: sqlite.prepare(
      `SELECT 1 FROM alert_deliveries WHERE rule_id = ? AND issue_id = ?
         AND status IN ('pending', 'sent') AND created_at > ? LIMIT 1`,
    ),
    sentInLastHour: sqlite.prepare(
      `SELECT COUNT(*) AS count FROM alert_deliveries WHERE rule_id = ?
         AND status IN ('pending', 'sent', 'failed') AND created_at > ?`,
    ),
    insert: sqlite.prepare(
      `INSERT INTO alert_deliveries (id, rule_id, project_id, issue_id, trigger_type, status, reason, attempts,
         next_attempt_at, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ),
    due: sqlite.prepare(
      `SELECT d.id, d.attempts, d.payload_json, r.channel_json, r.enabled
       FROM alert_deliveries d JOIN alert_rules r ON r.id = d.rule_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at LIMIT 20`,
    ),
    markDisabled: sqlite.prepare(
      "UPDATE alert_deliveries SET status = 'suppressed', reason = 'disabled', next_attempt_at = NULL WHERE id = ?",
    ),
    markSent: sqlite.prepare(
      "UPDATE alert_deliveries SET status = 'sent', attempts = ?, reason = NULL, next_attempt_at = NULL, sent_at = ? WHERE id = ?",
    ),
    markFailed: sqlite.prepare(
      "UPDATE alert_deliveries SET status = 'failed', attempts = ?, reason = ?, next_attempt_at = NULL WHERE id = ?",
    ),
    markRetry: sqlite.prepare(
      'UPDATE alert_deliveries SET attempts = ?, reason = ?, next_attempt_at = ? WHERE id = ?',
    ),
    markInvestigation: sqlite.prepare(
      'UPDATE alert_deliveries SET investigation_id = ?, investigation_note = ?, payload_json = ? WHERE id = ?',
    ),
  };
}

export class AlertDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private scheduled = false;
  private readonly sql: ReturnType<typeof dispatcherStatements>;

  constructor(
    private readonly database: TraceDatabase,
    private readonly options: DispatcherOptions,
  ) {
    this.sql = dispatcherStatements(database.sqlite);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** 开始定期处理。unref：只剩这个计时器时不阻止进程退出。 */
  start(): void {
    this.timer ??= setInterval(() => void this.run(), ALERT_LIMITS.pollIntervalMs);
    this.timer.unref();
  }

  /**
   * 接入之后调用：尽快处理一轮，但不在调用方（接入请求）里同步执行——run() 的第一段是同步的数据库读写，
   * 直接调用会算进接入请求的耗时。多次调用合并成一次。
   */
  nudge(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.run();
    });
  }

  /**
   * 处理一轮：活动记录 → 通知 → 发送到期的通知。同一时间只有一轮在跑；期间再被调用（接入后的 nudge），
   * 就在这一轮结束后再跑一轮，而不是并发地跑两轮，同一条通知不会被发两次。
   */
  run(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          this.processActivity();
          await this.sendDue();
        } while (this.again && !this.closed);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** 停止定期处理，等正在进行的一轮结束（关闭数据库之前调用）。 */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /**
   * 把待处理的活动记录变成通知（或被抑制的记录），和「标记已处理」在同一个事务里。
   * 先按触发条件筛规则，有规则要这条记录时才去读 Issue 的快照：没有配置告警的项目，每条记录只多一次批量标记。
   */
  processActivity(): void {
    const sql = this.sql;
    const now = this.now();
    const pending = sql.pending.all() as PendingActivity[];
    if (pending.length === 0) return;

    const rulesFor = new Map<string, RuleRow[]>();
    const rules = (projectId: string) => {
      let found = rulesFor.get(projectId);
      if (!found) {
        found = sql.rules.all(projectId) as RuleRow[];
        rulesFor.set(projectId, found);
      }
      return found;
    };

    // 要顺带发起调查的通知：发起调查会写库、在后台跑，不能放在下面的事务里，事务提交之后再逐个处理。
    const investigate: Array<{ deliveryId: string; projectId: string; message: AlertMessage }> = [];

    this.database.sqlite.transaction(() => {
      sql.markProcessed.run(pending.at(-1)!.id);
      for (const activity of pending) {
        const trigger = TRIGGER_OF[activity.kind];
        if (!trigger || now - activity.created_at > ALERT_LIMITS.staleAfterMs) continue;
        const candidates = rules(activity.project_id).filter((rule) =>
          parseJson<AlertTrigger[]>(rule.triggers_json, []).includes(trigger),
        );
        if (candidates.length === 0) continue;
        const issue = sql.snapshot.get(activity.issue_id) as IssueSnapshot | undefined;
        if (!issue) continue;
        const data = parseJson<Record<string, unknown>>(activity.data_json, {});
        const message: AlertMessage = {
          trigger,
          project: { id: activity.project_id, name: issue.project_name },
          issue: {
            id: activity.issue_id,
            title: issue.title,
            level: issue.level,
            status: issue.status,
            eventCount: issue.event_count,
            userCount: issue.user_count,
            firstSeenAt: issue.first_seen_at,
            lastSeenAt: issue.last_seen_at,
            release: issue.latest_release,
          },
          detail: describe(activity.kind, data, issue.latest_release),
          url: `${this.options.dashboardUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(activity.project_id)}/issues/${encodeURIComponent(activity.issue_id)}`,
        };
        for (const rule of candidates) {
          if (LEVEL_RANK[issue.level] < LEVEL_RANK[rule.min_level]) continue;
          // 被抑制的也记一行：界面上看得到「为什么没收到」，而不是什么都没发生。
          const reason =
            rule.muted_until !== null && rule.muted_until > now
              ? 'muted'
              : sql.recentForIssue.get(
                    rule.id,
                    activity.issue_id,
                    now - rule.interval_minutes * 60_000,
                  )
                ? 'interval'
                : (sql.sentInLastHour.get(rule.id, now - 3_600_000) as { count: number }).count >=
                    ALERT_LIMITS.perRulePerHour
                  ? 'rate_limited'
                  : null;
          const deliveryId = randomUUID();
          sql.insert.run(
            deliveryId,
            rule.id,
            activity.project_id,
            activity.issue_id,
            trigger,
            reason ? 'suppressed' : 'pending',
            reason,
            reason ? null : now,
            JSON.stringify(message),
            now,
          );
          if (!reason && rule.auto_investigate === 1) {
            investigate.push({ deliveryId, projectId: activity.project_id, message });
          }
        }
      }
    })();

    for (const request of investigate) {
      const result = this.options.investigations
        ? startAutoInvestigation(
            this.database,
            this.options.investigations,
            { id: request.message.issue.id, projectId: request.projectId },
            now,
          )
        : { note: 'disabled' as const };
      // 发起了就把调查的链接写进这条还没发出的通知，收到告警的人直接点进去看调查过程。
      const message: AlertMessage =
        'runId' in result
          ? {
              ...request.message,
              investigation: {
                id: result.runId,
                status: 'started',
                url: investigationUrl(request.message.url),
              },
            }
          : request.message;
      sql.markInvestigation.run(
        'runId' in result ? result.runId : null,
        'note' in result ? result.note : null,
        JSON.stringify(message),
        request.deliveryId,
      );
    }
  }

  /** 发送到期的通知（最多 20 条并发），按结果标记已发送、稍后重试或失败。 */
  async sendDue(): Promise<void> {
    const sql = this.sql;
    const now = this.now();
    const due = sql.due.all(now) as Array<{
      id: string;
      attempts: number;
      payload_json: string;
      channel_json: string;
      enabled: number;
    }>;
    await Promise.all(
      due.map(async (row) => {
        if (row.enabled !== 1) {
          sql.markDisabled.run(row.id);
          return;
        }
        const result = await sendToChannel(
          JSON.parse(row.channel_json) as AlertChannel,
          JSON.parse(row.payload_json) as AlertMessage,
          row.id,
          now,
          this.options,
        );
        // 发送期间数据库可能已被关闭（服务正在退出）：这一条留在 pending，下次启动再发。
        if (this.closed && !this.database.sqlite.open) return;
        const attempts = row.attempts + 1;
        if (result.ok) sql.markSent.run(attempts, this.now(), row.id);
        else if (attempts >= ALERT_LIMITS.maxAttempts)
          sql.markFailed.run(attempts, result.error, row.id);
        else sql.markRetry.run(attempts, result.error, now + retryDelay(attempts), row.id);
      }),
    );
  }
}

/**
 * 测试发送：用一条示例告警立即请求渠道，同步返回结果，并记一行 trigger 为 test 的通知。
 * 不经过发件箱——配置渠道时要的就是「现在能不能收到」。
 */
export async function sendTestAlert(
  database: TraceDatabase,
  ruleId: string,
  options: SendOptions & { dashboardUrl: string; now?: number },
): Promise<AlertTestResult | null> {
  const rule = ruleRow(database, ruleId);
  if (!rule) return null;
  const project = database.sqlite
    .prepare('SELECT name FROM projects WHERE id = ?')
    .get(rule.project_id) as { name: string };
  const now = options.now ?? Date.now();
  const message: AlertMessage = {
    trigger: 'test',
    project: { id: rule.project_id, name: project.name },
    issue: {
      id: 'test',
      title: `Test notification for "${rule.name}"`,
      level: 'error',
      status: 'unresolved',
      eventCount: 0,
      userCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      release: null,
    },
    detail: 'TracePilot can reach this channel. Real alerts look like this one.',
    url: `${options.dashboardUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(rule.project_id)}/settings`,
  };
  const id = randomUUID();
  const result = await sendToChannel(channelOf(rule), message, id, now, options);
  database.sqlite
    .prepare(
      `INSERT INTO alert_deliveries (id, rule_id, project_id, issue_id, trigger_type, status, reason, attempts,
         next_attempt_at, payload_json, created_at, sent_at)
       VALUES (?, ?, ?, NULL, 'test', ?, ?, 1, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      rule.id,
      rule.project_id,
      result.ok ? 'sent' : 'failed',
      result.error,
      JSON.stringify(message),
      now,
      result.ok ? now : null,
    );
  return result;
}
