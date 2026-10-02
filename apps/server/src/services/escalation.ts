import type { TraceDatabase } from '../db/client';
import { recordActivity } from './lifecycle';

/**
 * 恶化检测：一个老问题突然变多了。拿它最近一小时的事件数，和它自己过去 7 天的常态比。
 *
 * 新 Issue 和回归在接入时就能判断（有没有、是不是已解决），恶化不行——要看量。和 Sentry 的 escalating
 * 一样以 Issue 自己的历史为基线，而不是一个全局阈值：每小时 2 个的问题涨到 40 个是事故，每小时 500 个的
 * 问题涨到 520 个不是。Sentry 用过去几周的数据做逐日预测；这里简化成「过去 7 天平均每小时事件数的 5 倍，
 * 且至少 20 个」，好解释、好测，代价是对有明显昼夜周期的问题不够精细（倍数取 5 留出了余量）。
 *
 * 只看这些 Issue：未解决且还没标为恶化的；忽略到恶化为止的（恶化时重新打开）。已解决的再出现走回归，
 * 永久忽略的不管。出现不到一天的不判断：没有基线，任何量都像突增，而它们已经有「新 Issue」告警了。
 */
export const ESCALATION = {
  /** 比较最近这段时间的事件数。 */
  windowMs: 60 * 60_000,
  /** 和之前这么长时间的常态比。 */
  baselineMs: 7 * 24 * 60 * 60_000,
  /** Issue 至少出现了这么久才有基线可比。 */
  minAgeMs: 24 * 60 * 60_000,
  /** 最近一小时至少这么多事件才算恶化，避免 0 → 3 这种小数字被当成突增。 */
  floor: 20,
  /** 最近一小时超过常态每小时事件数的这么多倍。 */
  factor: 5,
  /** 同一个 Issue 最多每隔这么久检查一次：热点 Issue 每批都在接入，没必要每批都数一遍。 */
  checkIntervalMs: 60_000,
};

/** 恶化阈值：基线期内平均每小时事件数的 factor 倍，且不低于 floor。 */
export function escalationThreshold(baselineEvents: number, baselineHours: number): number {
  const perHour = baselineHours > 0 ? baselineEvents / baselineHours : 0;
  return Math.max(ESCALATION.floor, Math.ceil(perHour * ESCALATION.factor));
}

interface IssueRow {
  project_id: string;
  status: string;
  substatus: string | null;
  first_seen_at: number;
}

export class EscalationDetector {
  /** 每个 Issue 上次检查的时间。只在内存里：重启后最多多检查一次。 */
  private readonly lastChecked = new Map<string, number>();
  // 语句只编译一次：每批接入之后都要用，每次重新 prepare 的开销比查询本身还大。
  private readonly selectIssue;
  private readonly countEvents;
  private readonly markEscalating;

  constructor(private readonly database: TraceDatabase) {
    this.selectIssue = database.sqlite.prepare(
      'SELECT project_id, status, substatus, first_seen_at FROM issues WHERE id = ?',
    );
    // 两次计数都走 events(issue_id, created_at) 索引。
    this.countEvents = database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE issue_id = ? AND created_at > ? AND created_at <= ?',
    );
    this.markEscalating = database.sqlite.prepare(
      "UPDATE issues SET status = 'unresolved', substatus = 'escalating', substatus_at = ? WHERE id = ?",
    );
  }

  /** 接入之后对涉及的 Issue 检查一遍（每个 Issue 每分钟最多一次），返回这次判定为恶化的 Issue。 */
  check(issueIds: Iterable<string>, now = Date.now()): string[] {
    const escalated: string[] = [];
    for (const issueId of issueIds) {
      const last = this.lastChecked.get(issueId);
      if (last !== undefined && now - last < ESCALATION.checkIntervalMs) continue;
      this.lastChecked.set(issueId, now);
      if (this.evaluate(issueId, now)) escalated.push(issueId);
    }
    // 只是节流用的记录，太多时清掉早于一个检查间隔的。
    if (this.lastChecked.size > 10_000) {
      for (const [issueId, at] of this.lastChecked) {
        if (now - at >= ESCALATION.checkIntervalMs) this.lastChecked.delete(issueId);
      }
    }
    return escalated;
  }

  /** 判断一个 Issue 是否恶化；是的话改状态并写一条活动记录（同一个事务）。 */
  evaluate(issueId: string, now = Date.now()): boolean {
    const issue = this.selectIssue.get(issueId) as IssueRow | undefined;
    if (!issue) return false;
    const eligible =
      (issue.status === 'unresolved' && issue.substatus !== 'escalating') ||
      (issue.status === 'ignored' && issue.substatus === 'until_escalating');
    if (!eligible || now - issue.first_seen_at < ESCALATION.minAgeMs) return false;

    const windowStart = now - ESCALATION.windowMs;
    // 先数最近一小时，不到下限就不必再数 7 天。
    const count = (from: number, to: number) =>
      (this.countEvents.get(issueId, from, to) as { count: number }).count;
    const recent = count(windowStart, now);
    if (recent < ESCALATION.floor) return false;
    const baselineStart = Math.max(issue.first_seen_at - 1, windowStart - ESCALATION.baselineMs);
    const baselineHours = (windowStart - baselineStart) / 3_600_000;
    const baseline = count(baselineStart, windowStart);
    const threshold = escalationThreshold(baseline, baselineHours);
    if (recent < threshold) return false;

    this.database.sqlite.transaction(() => {
      this.markEscalating.run(now, issueId);
      recordActivity(
        this.database,
        { id: issueId, projectId: issue.project_id },
        'escalating',
        {
          recentEvents: recent,
          threshold,
          baselinePerHour: Math.round((baseline / baselineHours) * 100) / 100,
          ...(issue.status === 'ignored' ? { reopened: true } : {}),
        },
        now,
      );
    })();
    return true;
  }
}
