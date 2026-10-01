import type { TraceDatabase } from '../db/client';

/** 合并被拒绝的原因，路由据此返回 400 / 404 / 409。 */
export class MergeError extends Error {
  constructor(
    readonly code:
      'INVALID_MERGE' | 'ISSUE_NOT_FOUND' | 'DIFFERENT_PROJECT' | 'INVESTIGATION_RUNNING',
  ) {
    super(code);
  }
}

export interface MergeResult {
  id: string;
  /** 合并后的标题：和平时一样取最近一次出现的那个。 */
  title: string;
  /** 被并入并删除的 Issue 数。 */
  merged: number;
  eventCount: number;
  userCount: number;
}

/**
 * 把 sourceIds 这些 Issue 合并进 targetId：它们的指纹、事件和调查记录都改指向目标，然后删除它们。
 * 指纹一并迁移，所以之后再来的同类事件直接归入目标 Issue，不会重新长出被合并掉的那几个。
 *
 * 聚合算法再好也会把同一个问题拆开（消息里有没归一化掉的动态内容、同一个 bug 从两个入口触发），
 * 人工合并是兜底，Sentry 等产品同样提供。合并后：
 * - 首末次出现取所有 Issue 的最早和最晚，标题和平时一样取最近一次出现的那个；
 * - 事件数和影响用户数按迁移后的事件重新统计（同一个用户在两个 Issue 里都出现过，只算一次）；
 * - 处理状态和级别保留目标 Issue 的；单次诊断的缓存随被合并的 Issue 一起删除（证据变了，缓存作废）。
 *
 * 任何一方有进行中的调查时拒绝：调查的工具上下文绑定在原来的 Issue 上，合并会让它读到一个已经不存在的 Issue。
 */
export function mergeIssues(
  database: TraceDatabase,
  targetId: string,
  sourceIds: string[],
): MergeResult {
  const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);
  if (sources.length === 0) throw new MergeError('INVALID_MERGE');
  const all = [targetId, ...sources];
  // 参数个数随 Issue 数变化，占位符按个数生成；值本身仍然走参数绑定。
  const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');
  const inAll = placeholders(all.length);
  const inSources = placeholders(sources.length);

  return database.sqlite.transaction((): MergeResult => {
    const rows = database.sqlite
      .prepare(`SELECT id, project_id FROM issues WHERE id IN (${inAll})`)
      .all(...all) as Array<{ id: string; project_id: string }>;
    if (rows.length !== all.length) throw new MergeError('ISSUE_NOT_FOUND');
    if (new Set(rows.map((row) => row.project_id)).size > 1) {
      throw new MergeError('DIFFERENT_PROJECT');
    }
    const running = database.sqlite
      .prepare(
        `SELECT 1 FROM investigation_runs WHERE issue_id IN (${inAll}) AND status = 'running' LIMIT 1`,
      )
      .get(...all);
    if (running) throw new MergeError('INVESTIGATION_RUNNING');

    for (const table of ['issue_fingerprints', 'events', 'investigation_runs']) {
      database.sqlite
        .prepare(`UPDATE ${table} SET issue_id = ? WHERE issue_id IN (${inSources})`)
        .run(targetId, ...sources);
    }
    // 先按全部 Issue 算出合并后的值，再删除被合并的那些（子查询还要读它们的行）。
    database.sqlite
      .prepare(
        `UPDATE issues SET
           first_seen_at = (SELECT MIN(first_seen_at) FROM issues WHERE id IN (${inAll})),
           last_seen_at = (SELECT MAX(last_seen_at) FROM issues WHERE id IN (${inAll})),
           title = (SELECT title FROM issues WHERE id IN (${inAll}) ORDER BY last_seen_at DESC LIMIT 1),
           event_count = (SELECT COUNT(*) FROM events WHERE issue_id = ?),
           user_count = (SELECT COUNT(DISTINCT user_id) FROM events
             WHERE issue_id = ? AND user_id IS NOT NULL)
         WHERE id = ?`,
      )
      .run(...all, ...all, ...all, targetId, targetId, targetId);
    database.sqlite.prepare(`DELETE FROM issues WHERE id IN (${inSources})`).run(...sources);
    const merged = database.sqlite
      .prepare('SELECT title, event_count, user_count FROM issues WHERE id = ?')
      .get(targetId) as { title: string; event_count: number; user_count: number };
    return {
      id: targetId,
      title: merged.title,
      merged: sources.length,
      eventCount: merged.event_count,
      userCount: merged.user_count,
    };
  })();
}
