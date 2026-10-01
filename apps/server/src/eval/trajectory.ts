import { createHash } from 'node:crypto';
import type { InvestigationEvent } from '@trace-pilot/shared';

/**
 * 轨迹指标：不只看结论对不对，也看 Agent 是怎么得出结论的。
 *
 * 结论碰巧说对、但一次都没看过关键证据，和查到了证据再下结论，分数一样却不是一回事；
 * 同样的工具同样的参数调两遍、传错参数、报告被驳回，都在花 token 而不增加信息。
 * 数据来自调查过程中发出的事件——和界面通过 SSE 收到的是同一串，评测不需要另外埋点。
 */

export interface TrajectoryCall {
  /** 模型可见的结果编号（T1、T2……）。 */
  ref: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** 工具结果的 SHA-256（前 16 位）。回放时用它找出哪一步的工具输出和录制时不同。 */
  outputDigest: string;
}

export interface Trajectory {
  /** 实际执行的工具调用，按发生顺序（被跳过的不算）。 */
  calls: TrajectoryCall[];
  /** 模型调用的轮数。 */
  steps: number;
  /** 与之前某次调用的工具和参数完全相同：结果不会变，重复调用只是在花预算。 */
  redundantCalls: number;
  /** 返回错误的调用（参数不合法、事件不存在、超时……）。工具如实回答「没有这份数据」不算失败。 */
  failedCalls: number;
  /** 被驳回的报告次数（形状或引用核对没通过，模型改了再交）。 */
  rejectedReports: number;
  /**
   * 用例标注的关键证据工具（EvalCase.evidenceTools）里，被成功调用过的比例。
   * 1 表示每份关键证据都看过；低于 1 时 missedEvidenceTools 列出没看的。
   */
  evidenceToolRecall: number | null;
  missedEvidenceTools: string[];
}

/** 参数的规范形式：键排序后序列化，{a,b} 和 {b,a} 视为同一组参数。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 从一次调查的事件序列里统计轨迹指标。 */
export function summarizeTrajectory(
  events: readonly InvestigationEvent[],
  evidenceTools: readonly string[] = [],
): Trajectory {
  const calls: TrajectoryCall[] = [];
  const pending = new Map<string, Omit<TrajectoryCall, 'ok' | 'outputDigest'>>();
  let steps = 0;
  let rejectedReports = 0;
  for (const event of events) {
    if (event.type === 'step.started') steps = Math.max(steps, event.step);
    else if (event.type === 'report.rejected') rejectedReports += 1;
    else if (event.type === 'tool.called') {
      pending.set(event.toolCallId, { ref: event.ref, name: event.name, args: event.args });
    } else if (event.type === 'tool.completed') {
      const called = pending.get(event.toolCallId);
      if (!called) continue;
      pending.delete(event.toolCallId);
      calls.push({ ...called, ok: event.ok, outputDigest: digest(event.output) });
    }
  }

  const seen = new Set<string>();
  let redundantCalls = 0;
  for (const call of calls) {
    const key = `${call.name}\u0000${canonical(call.args)}`;
    if (seen.has(key)) redundantCalls += 1;
    else seen.add(key);
  }
  const succeeded = new Set(calls.filter((call) => call.ok).map((call) => call.name));
  const missedEvidenceTools = evidenceTools.filter((tool) => !succeeded.has(tool));
  return {
    calls,
    steps,
    redundantCalls,
    failedCalls: calls.filter((call) => !call.ok).length,
    rejectedReports,
    evidenceToolRecall:
      evidenceTools.length === 0
        ? null
        : (evidenceTools.length - missedEvidenceTools.length) / evidenceTools.length,
    missedEvidenceTools,
  };
}
