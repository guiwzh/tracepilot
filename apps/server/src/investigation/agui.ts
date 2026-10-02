import { EventType, PROTOCOL_VERSION, type BaseEvent, type TokenUsage } from '@ag-ui/core';
import type {
  InvestigationEvent,
  InvestigationReport,
  InvestigationRun,
  InvestigationStreamEvent,
  InvestigationUsage,
} from '@trace-pilot/shared';

/**
 * 把调查的事件日志投影成 AG-UI（Agent–User Interaction Protocol，https://docs.ag-ui.com）1.0 的标准事件：
 * CopilotKit 这类 AG-UI 前端不用认识 TracePilot 的事件，就能显示旁白、工具调用和结果、运行的开始与结束。
 *
 * 事件日志仍是唯一的事实来源（落库、可回放，工作台读它），AG-UI 只是出口上的一层翻译：
 * - 旁白        → TEXT_MESSAGE_START / CONTENT / END（每段旁白一条 assistant 消息）
 * - 工具调用    → TOOL_CALL_START / ARGS / END，结果 → TOOL_CALL_RESULT；短编号 ref、耗时等放在 metadata.tracepilot
 * - 循环的一轮  → STEP_STARTED / STEP_FINISHED
 * - 报告、被驳回的引用、用量 → 共享状态：开头一个 STATE_SNAPSHOT，之后用 STATE_DELTA（JSON Patch）更新。
 *   协议没有「证据核验」这种概念，状态正是让前端拿到领域数据的标准位置。
 * - 完成 → RUN_FINISHED（outcome success，result 是报告）；取消 → RUN_FINISHED（outcome cancelled）；
 *   失败 → RUN_ERROR。用量按协议的 TokenUsage 给出。
 *
 * 编码器有状态（哪条消息、哪一轮还开着），但只取决于日志本身：从头重放同一份日志得到同样的事件序列。
 * SSE 续传靠这一点：事件的 id 是「seq.序号」，重连时从头编码、跳过已经发过的。
 */

/** 前端看到的共享状态。 */
export interface InvestigationAgentState {
  issueId: string;
  runId: string;
  engine: InvestigationRun['engine'] | null;
  model: string | null;
  status: InvestigationRun['status'];
  /** 被服务端驳回的报告：引用对不上工具结果时，模型要修正后重交。 */
  rejections: Array<{ step: number; problems: string[] }>;
  report: InvestigationReport | null;
  usage: InvestigationUsage | null;
  error: { code: string; message: string } | null;
}

/** 一个 AG-UI 事件，连同它在 SSE 里的 id。 */
export interface EncodedAgUiEvent {
  id: string;
  event: BaseEvent;
}

function tokenUsage(model: string | null, usage: InvestigationUsage): TokenUsage[] {
  return [
    {
      ...(model ? { model } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    },
  ];
}

export class AgUiEncoder {
  private engine: InvestigationRun['engine'] | null = null;
  private model: string | null = null;
  private step: number | null = null;
  private message: string | null = null;
  /** 这一轮最近一条旁白：工具调用挂在它下面（parentMessageId）。 */
  private stepMessage: string | null = null;
  private messageCount = 0;

  constructor(
    private readonly runId: string,
    private readonly issueId: string,
  ) {}

  /** 一条日志记录对应的 AG-UI 事件，按顺序编号为「seq.0」「seq.1」…… */
  encode(record: InvestigationStreamEvent): EncodedAgUiEvent[] {
    const events = this.translate(record.event).map((event) => ({
      ...event,
      timestamp: record.at,
    }));
    return events.map((event, index) => ({ id: `${record.seq}.${index}`, event }));
  }

  private translate(event: InvestigationEvent): BaseEvent[] {
    switch (event.type) {
      case 'run.started':
        this.engine = event.engine;
        this.model = event.model;
        return [
          {
            type: EventType.RUN_STARTED,
            threadId: this.issueId,
            runId: this.runId,
            protocolVersion: PROTOCOL_VERSION,
          } as BaseEvent,
          {
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.initialState(),
          } as BaseEvent,
        ];
      case 'step.started': {
        const events = [...this.closeMessage(), ...this.closeStep()];
        this.step = event.step;
        this.stepMessage = null;
        return [
          ...events,
          { type: EventType.STEP_STARTED, stepName: `step ${event.step}` } as BaseEvent,
        ];
      }
      case 'text.delta': {
        // 协议不允许空的 delta。
        if (event.text.length === 0) return [];
        const events: BaseEvent[] = [];
        if (!this.message) {
          this.messageCount += 1;
          this.message = `${this.runId}:message-${this.messageCount}`;
          this.stepMessage = this.message;
          events.push({
            type: EventType.TEXT_MESSAGE_START,
            messageId: this.message,
            role: 'assistant',
          } as BaseEvent);
        }
        events.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.message,
          delta: event.text,
        } as BaseEvent);
        return events;
      }
      case 'tool.called':
        return [
          // 旁白说完才开始调工具：先把这条消息收尾，工具调用挂在它下面。
          ...this.closeMessage(),
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: event.toolCallId,
            toolCallName: event.name,
            ...(this.stepMessage ? { parentMessageId: this.stepMessage } : {}),
            metadata: { tracepilot: { ref: event.ref, step: event.step } },
          } as BaseEvent,
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: event.toolCallId,
            delta: JSON.stringify(event.args),
          } as BaseEvent,
          { type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId } as BaseEvent,
        ];
      case 'tool.completed':
        return [
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${event.toolCallId}:result`,
            toolCallId: event.toolCallId,
            content: event.output,
            role: 'tool',
            metadata: {
              tracepilot: {
                ok: event.ok,
                truncated: event.truncated,
                durationMs: event.durationMs,
              },
            },
          } as BaseEvent,
        ];
      case 'report.rejected':
        return [
          {
            type: EventType.STATE_DELTA,
            delta: [
              {
                op: 'add',
                path: '/rejections/-',
                value: { step: event.step, problems: event.problems },
              },
            ],
          } as BaseEvent,
        ];
      case 'run.completed':
        return [
          ...this.close(),
          this.finalState([
            { op: 'replace', path: '/status', value: 'completed' },
            { op: 'replace', path: '/report', value: event.report },
            { op: 'replace', path: '/usage', value: event.usage },
          ]),
          {
            type: EventType.RUN_FINISHED,
            threadId: this.issueId,
            runId: this.runId,
            result: event.report,
            outcome: { type: 'success' },
            usage: tokenUsage(this.model, event.usage),
          } as BaseEvent,
        ];
      case 'run.cancelled':
        return [
          ...this.close(),
          this.finalState([
            { op: 'replace', path: '/status', value: 'cancelled' },
            { op: 'replace', path: '/usage', value: event.usage },
          ]),
          {
            type: EventType.RUN_FINISHED,
            threadId: this.issueId,
            runId: this.runId,
            outcome: { type: 'cancelled' },
            usage: tokenUsage(this.model, event.usage),
          } as BaseEvent,
        ];
      case 'run.failed':
        return [
          ...this.close(),
          this.finalState([
            { op: 'replace', path: '/status', value: 'failed' },
            { op: 'replace', path: '/usage', value: event.usage },
            { op: 'replace', path: '/error', value: { code: event.error, message: event.message } },
          ]),
          {
            type: EventType.RUN_ERROR,
            message: event.message,
            code: event.error,
            usage: tokenUsage(this.model, event.usage),
          } as BaseEvent,
        ];
    }
  }

  private initialState(): InvestigationAgentState {
    return {
      issueId: this.issueId,
      runId: this.runId,
      engine: this.engine,
      model: this.model,
      status: 'running',
      rejections: [],
      report: null,
      usage: null,
      error: null,
    };
  }

  private finalState(delta: Array<{ op: 'replace'; path: string; value: unknown }>): BaseEvent {
    return { type: EventType.STATE_DELTA, delta } as BaseEvent;
  }

  private closeMessage(): BaseEvent[] {
    if (!this.message) return [];
    const messageId = this.message;
    this.message = null;
    return [{ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent];
  }

  private closeStep(): BaseEvent[] {
    if (this.step === null) return [];
    const stepName = `step ${this.step}`;
    this.step = null;
    return [{ type: EventType.STEP_FINISHED, stepName } as BaseEvent];
  }

  /** 运行结束之前，开着的消息和轮次都要收尾：协议不允许带着它们结束。 */
  private close(): BaseEvent[] {
    return [...this.closeMessage(), ...this.closeStep()];
  }
}

/**
 * SSE 续传位置：「seq.序号」表示这条之前（含）的都发过了；只有 seq（工作台事件流的写法）表示
 * 这条记录的事件全部发过了。
 */
export function parseAgUiCursor(value: unknown): { seq: number; index: number } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return { seq: 0, index: Number.POSITIVE_INFINITY };
  return {
    seq: Number(match[1]),
    index: match[2] === undefined ? Number.POSITIVE_INFINITY : Number(match[2]),
  };
}
