import type {
  InvestigationReport,
  InvestigationRun,
  InvestigationStreamEvent,
  InvestigationUsage,
} from '@trace-pilot/shared';

/**
 * 把服务端推来的事件流折叠成界面状态。纯函数，不碰网络和 DOM，单独测试。
 *
 * 事件按 seq 去重：断线重连、回放和实时推送可能把同一个事件送来两次，
 * 已处理过的 seq 直接忽略，界面不会出现重复的步骤或工具调用。
 */
export interface ToolCallView {
  id: string;
  /** 模型引用这次调用时用的编号，例如 T3。 */
  ref: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  output?: string;
  truncated?: boolean;
  durationMs?: number;
}

export interface StepView {
  step: number;
  text: string;
  toolCalls: ToolCallView[];
  rejected: string[][];
}

export interface InvestigationViewState {
  lastSeq: number;
  status: 'idle' | InvestigationRun['status'];
  engine: InvestigationRun['engine'] | null;
  model: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  steps: StepView[];
  report: InvestigationReport | null;
  error: { code: string; message: string } | null;
  usage: InvestigationUsage | null;
}

export type InvestigationAction =
  { type: 'reset' } | { type: 'events'; records: InvestigationStreamEvent[] };

export const initialInvestigationState: InvestigationViewState = {
  lastSeq: 0,
  status: 'idle',
  engine: null,
  model: null,
  startedAt: null,
  finishedAt: null,
  steps: [],
  report: null,
  error: null,
  usage: null,
};

function withStep(
  steps: StepView[],
  step: number,
  update: (current: StepView) => StepView,
): StepView[] {
  const index = steps.findIndex((item) => item.step === step);
  if (index === -1) return [...steps, update({ step, text: '', toolCalls: [], rejected: [] })];
  return steps.map((item, position) => (position === index ? update(item) : item));
}

function apply(
  state: InvestigationViewState,
  record: InvestigationStreamEvent,
): InvestigationViewState {
  const { event } = record;
  switch (event.type) {
    case 'run.started':
      return {
        ...state,
        status: 'running',
        engine: event.engine,
        model: event.model,
        startedAt: record.at,
      };
    case 'step.started':
      return { ...state, steps: withStep(state.steps, event.step, (step) => step) };
    case 'text.delta':
      return {
        ...state,
        steps: withStep(state.steps, event.step, (step) => ({
          ...step,
          text: step.text + event.text,
        })),
      };
    case 'tool.called':
      return {
        ...state,
        steps: withStep(state.steps, event.step, (step) => ({
          ...step,
          toolCalls: [
            ...step.toolCalls,
            {
              id: event.toolCallId,
              ref: event.ref,
              name: event.name,
              args: event.args,
              status: 'running',
            },
          ],
        })),
      };
    case 'tool.completed':
      return {
        ...state,
        steps: withStep(state.steps, event.step, (step) => ({
          ...step,
          toolCalls: step.toolCalls.map((call) =>
            call.id === event.toolCallId
              ? {
                  ...call,
                  status: event.ok ? 'ok' : 'error',
                  output: event.output,
                  truncated: event.truncated,
                  durationMs: event.durationMs,
                }
              : call,
          ),
        })),
      };
    case 'report.rejected':
      return {
        ...state,
        steps: withStep(state.steps, event.step, (step) => ({
          ...step,
          rejected: [...step.rejected, event.problems],
        })),
      };
    case 'run.completed':
      return {
        ...state,
        status: 'completed',
        report: event.report,
        usage: event.usage,
        finishedAt: record.at,
      };
    case 'run.failed':
      return {
        ...state,
        status: 'failed',
        error: { code: event.error, message: event.message },
        usage: event.usage,
        finishedAt: record.at,
      };
    case 'run.cancelled':
      return { ...state, status: 'cancelled', usage: event.usage, finishedAt: record.at };
    default:
      return state;
  }
}

export function investigationReducer(
  state: InvestigationViewState,
  action: InvestigationAction,
): InvestigationViewState {
  if (action.type === 'reset') return initialInvestigationState;
  let next = state;
  for (const record of action.records) {
    if (record.seq <= next.lastSeq) continue;
    next = { ...apply(next, record), lastSeq: record.seq };
  }
  return next;
}

/** 按 toolCallId 找到对应的工具调用，报告里的引用据此跳回时间线。 */
export function findToolCall(state: InvestigationViewState, id: string): ToolCallView | undefined {
  for (const step of state.steps) {
    const call = step.toolCalls.find((item) => item.id === id);
    if (call) return call;
  }
  return undefined;
}
