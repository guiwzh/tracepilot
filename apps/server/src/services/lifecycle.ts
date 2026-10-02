import type { IssueActivity, IssueStatus, IssueSubstatus } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson } from '../lib/json';

/**
 * Issue 的生命周期：状态（unresolved / resolved / ignored）、状态的细分（substatus），以及一条记录
 * 每次变化的活动流（issue_activity）。
 *
 *   新建 ──► unresolved ──人：解决──► resolved ──又出现（晚于解决时间）──► unresolved + regressed
 *              │  ▲                                                    （接入时判断，services/events.ts）
 *              │  └─ 事件量远超它自己的常态 ── unresolved + escalating（services/escalation.ts）
 *              └─人：忽略到恶化为止──► ignored + until_escalating ──恶化──► unresolved + escalating
 *
 * 新建、回归、恶化这三种变化会触发告警。它们的活动记录和 Issue 的变化写在同一个事务里，告警从活动流里取
 * （事务性发件箱，见 services/alerts.ts）：Issue 变了就一定会有记录，发通知在事务之外进行，不拖慢接入。
 */

/** 会触发告警的活动及对应的触发条件；其余的只是时间线上的记录。 */
const ALERT_TRIGGERS: Partial<Record<IssueActivity['kind'], string>> = {
  created: 'new_issue',
  regressed: 'regression',
  escalating: 'escalating',
};

/** 每个数据库连接一份编译好的语句：接入事务里每新建一个 Issue 都要用。 */
const statements = new WeakMap<TraceDatabase, ReturnType<typeof prepareStatements>>();

function prepareStatements(database: TraceDatabase) {
  return {
    insert: database.sqlite.prepare(
      `INSERT INTO issue_activity (project_id, issue_id, kind, data_json, processed, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    // json_each 把规则的 triggers_json 展开成行，精确匹配某个触发条件。
    wanted: database.sqlite.prepare(
      `SELECT 1 FROM alert_rules r, json_each(r.triggers_json) t
       WHERE r.project_id = ? AND r.enabled = 1 AND t.value = ? LIMIT 1`,
    ),
  };
}

/**
 * 写一条活动记录。只有这个项目有启用的规则订阅了它，记录才进入「待处理」等分发器取走；
 * 否则写入时就标记为已处理：没有配置告警的项目不必为每个新 Issue 多一轮分发。之后才建的规则
 * 不追溯之前的变化（告警说的是「现在」）。返回这条记录是否在等待告警。
 */
export function recordActivity(
  database: TraceDatabase,
  issue: { id: string; projectId: string },
  kind: IssueActivity['kind'],
  data: Record<string, unknown>,
  at: number,
): boolean {
  let sql = statements.get(database);
  if (!sql) {
    sql = prepareStatements(database);
    statements.set(database, sql);
  }
  const trigger = ALERT_TRIGGERS[kind];
  const queued = trigger !== undefined && Boolean(sql.wanted.get(issue.projectId, trigger));
  sql.insert.run(issue.projectId, issue.id, kind, JSON.stringify(data), queued ? 0 : 1, at);
  return queued;
}

/** 一个 Issue 的活动记录，新的在前。 */
export function listActivity(
  database: TraceDatabase,
  issueId: string,
  limit = 50,
): IssueActivity[] {
  const rows = database.sqlite
    .prepare(
      'SELECT id, kind, data_json, created_at FROM issue_activity WHERE issue_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(issueId, limit) as Array<{
    id: number;
    kind: IssueActivity['kind'];
    data_json: string;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    data: parseJson<Record<string, unknown>>(row.data_json, {}),
    createdAt: row.created_at,
  }));
}

/**
 * 人改状态。substatus 随之清除——人看过了，「刚回归」「正在恶化」的提示完成了使命；
 * 选择「忽略到恶化为止」时记为 until_escalating。标记已解决时记下时间：之后发生的事件才算回归。
 * 返回 null 表示没有这个 Issue。
 */
export function setIssueStatus(
  database: TraceDatabase,
  issueId: string,
  status: IssueStatus,
  untilEscalating = false,
  now = Date.now(),
): { id: string; status: IssueStatus; substatus: IssueSubstatus | null } | null {
  return database.sqlite.transaction(() => {
    const current = database.sqlite
      .prepare('SELECT project_id, status, substatus FROM issues WHERE id = ?')
      .get(issueId) as
      { project_id: string; status: IssueStatus; substatus: IssueSubstatus | null } | undefined;
    if (!current) return null;
    const substatus: IssueSubstatus | null =
      status === 'ignored' && untilEscalating ? 'until_escalating' : null;
    database.sqlite
      .prepare(
        'UPDATE issues SET status = ?, resolved_at = ?, substatus = ?, substatus_at = ? WHERE id = ?',
      )
      .run(status, status === 'resolved' ? now : null, substatus, substatus ? now : null, issueId);
    recordActivity(
      database,
      { id: issueId, projectId: current.project_id },
      'status_changed',
      {
        from: current.status,
        to: status,
        ...(current.substatus ? { fromSubstatus: current.substatus } : {}),
        ...(substatus ? { substatus } : {}),
      },
      now,
    );
    return { id: issueId, status, substatus };
  })();
}
