import { randomUUID } from 'node:crypto';
import type { InvestigationRun } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson } from '../lib/json';
import type { AlertMessage } from './alertChannels';

/**
 * 告警触发的自动调查：告警发出时顺带发起一次排障调查，工程师点开告警时，带引用核验的报告已经在那里了；
 * 调查结束后再给同一个渠道发一条跟进通知（结论、首要原因、引用核验结果，或者停在了哪里）。
 *
 * 每次调查都要多次调用计费的模型，所以有两道闸：
 * - 每个项目 24 小时内，告警最多发起 N 次（AUTO_INVESTIGATIONS_PER_DAY，默认 10；0 表示关闭）；
 * - 同一个 Issue 24 小时内已经调查过（不论是人点的还是告警发起的），不再自动发起。
 * 被静默、去重而没有发出的告警不发起调查：没人会收到它，也就没人等这份报告。
 */

export const AUTO_INVESTIGATION = {
  /** 每日上限按滚动的 24 小时计，不按自然日：没有时区问题，也不会在零点前后连发两批。 */
  windowMs: 24 * 60 * 60_000,
  cooldownMs: 24 * 60 * 60_000,
};

/** 规则要求自动调查、却没有发起的原因。 */
export type InvestigationNote = 'cooldown' | 'daily_limit' | 'busy' | 'disabled';

/** 告警模块需要的调查服务能力。app.ts 用 InvestigationService 适配，测试用替身。 */
export interface InvestigationStarter {
  /** 每个项目 24 小时内最多自动发起几次；0 表示关闭。 */
  dailyLimit: number;
  /** 以「告警发起」的身份为 Issue 发起调查；同时进行的调查已满时返回 busy。 */
  start(issueId: string): { runId: string } | { skipped: 'busy' | 'issue_not_found' };
}

/** 检查两道闸，通过就发起调查。 */
export function startAutoInvestigation(
  database: TraceDatabase,
  starter: InvestigationStarter,
  issue: { id: string; projectId: string },
  now: number,
): { runId: string } | { note: InvestigationNote } {
  if (starter.dailyLimit <= 0) return { note: 'disabled' };
  const recent = database.sqlite
    .prepare('SELECT 1 FROM investigation_runs WHERE issue_id = ? AND started_at > ? LIMIT 1')
    .get(issue.id, now - AUTO_INVESTIGATION.cooldownMs);
  if (recent) return { note: 'cooldown' };
  const used = database.sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM investigation_runs r JOIN issues i ON i.id = r.issue_id
       WHERE i.project_id = ? AND r.started_by = 'alert' AND r.started_at > ?`,
    )
    .get(issue.projectId, now - AUTO_INVESTIGATION.windowMs) as { count: number };
  if (used.count >= starter.dailyLimit) return { note: 'daily_limit' };
  const result = starter.start(issue.id);
  return 'runId' in result ? { runId: result.runId } : { note: 'busy' };
}

/** 工作台里一次调查的地址：Issue 详情的 Investigation 标签。 */
export function investigationUrl(issueUrl: string): string {
  return `${issueUrl}?tab=investigation`;
}

/**
 * 跟进通知的正文。完成时给出结论、首要原因和引用核验；离线脚本跑的如实标注，不冒充模型推理。
 * 结论来自模型，而模型读的是不可信的遥测，所以同样经过渠道的转义（alertChannels.ts）。
 */
export function followUpDetail(run: InvestigationRun): string {
  if (run.status !== 'completed' || !run.report) {
    return run.status === 'cancelled'
      ? 'The investigation was cancelled.'
      : `The investigation stopped (${run.error ?? 'unknown error'}). Open it to see how far it got.`;
  }
  const report = run.report;
  const top = [...report.possibleCauses].sort((a, b) => b.confidence - a.confidence)[0];
  const verified = report.evidence.filter((item) => item.verified).length;
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return [
    clip(report.summary, 400),
    top ? `Top cause (confidence ${top.confidence.toFixed(2)}): ${clip(top.cause, 240)}` : null,
    `${verified}/${report.evidence.length} citations verified against tool output.`,
    run.engine === 'local'
      ? 'Offline demo script (no model key configured), not model reasoning.'
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 告警发起的调查结束时调用：找到发起它的那条通知，给同一条规则的渠道排一条跟进通知（走同一个发件箱）。
 * 规则已经删除或停用时不发；静默中记为 suppressed。返回是否排上了待发送的通知。
 */
export function enqueueFollowUp(
  database: TraceDatabase,
  run: InvestigationRun,
  now: number,
): boolean {
  const origin = database.sqlite
    .prepare(
      `SELECT d.rule_id, d.project_id, d.issue_id, d.payload_json, r.enabled, r.muted_until
       FROM alert_deliveries d JOIN alert_rules r ON r.id = d.rule_id
       WHERE d.investigation_id = ? AND d.trigger_type != 'investigation'
       ORDER BY d.created_at LIMIT 1`,
    )
    .get(run.id) as
    | {
        rule_id: string;
        project_id: string;
        issue_id: string | null;
        payload_json: string;
        enabled: number;
        muted_until: number | null;
      }
    | undefined;
  if (!origin || origin.enabled !== 1) return false;
  const previous = parseJson<AlertMessage | null>(origin.payload_json, null);
  if (!previous) return false;
  const message: AlertMessage = {
    ...previous,
    trigger: 'investigation',
    detail: followUpDetail(run),
    investigation: {
      id: run.id,
      status: run.status === 'running' ? 'started' : run.status,
      url: investigationUrl(previous.url),
    },
  };
  const muted = origin.muted_until !== null && origin.muted_until > now;
  database.sqlite
    .prepare(
      `INSERT INTO alert_deliveries (id, rule_id, project_id, issue_id, trigger_type, status, reason, attempts,
         next_attempt_at, payload_json, investigation_id, created_at)
       VALUES (?, ?, ?, ?, 'investigation', ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      origin.rule_id,
      origin.project_id,
      origin.issue_id,
      muted ? 'suppressed' : 'pending',
      muted ? 'muted' : null,
      muted ? null : now,
      JSON.stringify(message),
      run.id,
      now,
    );
  return !muted;
}
