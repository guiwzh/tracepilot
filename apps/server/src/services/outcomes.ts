import type { FilterReason, IngestStats, RateLimitReason } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';

/**
 * 上报去向的计数：每个信封里的事件最后是被收下、被入站过滤丢掉，还是被限流拒收。
 * 没有这份计数，过滤和限流就是「看不见的丢数据」：Issue 列表里的数字比真实发生的少，却没人知道少了多少。
 * Sentry 把它叫作 outcomes，在 Stats 页面按原因展示。
 *
 * 计数先在内存里按「项目 + 小时 + 去向 + 原因」累加，每 10 秒合并写入一次 ingest_outcomes，
 * 而不是每个请求都写一行：接入是写入最频繁的路径，多一次落盘就多一次 fsync。
 * 代价是进程崩溃时丢掉最近不到 10 秒的计数；正常关闭时会先写完（app.ts 的 onClose）。
 */

export type Outcome = 'accepted' | 'filtered' | 'rate_limited';

const HOUR = 3_600_000;
const FLUSH_INTERVAL_MS = 10_000;

interface Pending {
  projectId: string;
  hour: number;
  outcome: Outcome;
  reason: string;
  count: number;
}

export class OutcomeRecorder {
  private pending = new Map<string, Pending>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly database: TraceDatabase) {
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // 不让这个定时器单独撑着进程不退出。
    this.timer.unref();
  }

  record(
    projectId: string,
    outcome: Outcome,
    count: number,
    reason: FilterReason | RateLimitReason | '' = '',
    at = Date.now(),
  ): void {
    if (count <= 0) return;
    const hour = Math.floor(at / HOUR) * HOUR;
    const key = `${projectId}\u0000${hour}\u0000${outcome}\u0000${reason}`;
    const existing = this.pending.get(key);
    if (existing) existing.count += count;
    else this.pending.set(key, { projectId, hour, outcome, reason, count });
  }

  /** 把内存里的计数合并写进数据库。读统计之前和应用关闭时也会调用。 */
  flush(): void {
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending = new Map();
    // 项目在这期间被删除时跳过它的计数（外键会拒绝插入，一行失败会让整批回滚）。
    const upsert = this.database.sqlite.prepare(
      `INSERT INTO ingest_outcomes (project_id, hour, outcome, reason, count)
       SELECT @projectId, @hour, @outcome, @reason, @count
       WHERE EXISTS (SELECT 1 FROM projects WHERE id = @projectId)
       ON CONFLICT(project_id, hour, outcome, reason) DO UPDATE SET count = count + excluded.count`,
    );
    this.database.sqlite.transaction(() => {
      for (const row of rows) upsert.run(row);
    })();
  }

  /** 停止定时写入并写完剩下的计数。 */
  close(): void {
    clearInterval(this.timer);
    this.flush();
  }
}

/** 最近 hours 小时（含当前这一小时）的上报去向。 */
export function ingestStats(
  database: TraceDatabase,
  projectId: string,
  hours = 24,
  now = Date.now(),
): IngestStats {
  const currentHour = Math.floor(now / HOUR) * HOUR;
  const since = currentHour - (hours - 1) * HOUR;
  const rows = database.sqlite
    .prepare(
      `SELECT hour, outcome, reason, count FROM ingest_outcomes
       WHERE project_id = ? AND hour >= ? ORDER BY hour`,
    )
    .all(projectId, since) as Array<{
    hour: number;
    outcome: Outcome;
    reason: string;
    count: number;
  }>;
  const stats: IngestStats = {
    windowHours: hours,
    accepted: 0,
    filtered: {},
    rateLimited: {},
    hourly: [],
  };
  // 每个小时一格，没有上报的小时补 0，图表的横轴才连续。
  const hourly = new Map<number, IngestStats['hourly'][number]>();
  for (let hour = since; hour <= currentHour; hour += HOUR) {
    const slot = { hour, accepted: 0, filtered: 0, rateLimited: 0 };
    hourly.set(hour, slot);
    stats.hourly.push(slot);
  }
  for (const row of rows) {
    const slot = hourly.get(row.hour);
    if (row.outcome === 'accepted') {
      stats.accepted += row.count;
      if (slot) slot.accepted += row.count;
    } else if (row.outcome === 'filtered') {
      const reason = row.reason as FilterReason;
      stats.filtered[reason] = (stats.filtered[reason] ?? 0) + row.count;
      if (slot) slot.filtered += row.count;
    } else {
      const reason = row.reason as RateLimitReason;
      stats.rateLimited[reason] = (stats.rateLimited[reason] ?? 0) + row.count;
      if (slot) slot.rateLimited += row.count;
    }
  }
  return stats;
}
