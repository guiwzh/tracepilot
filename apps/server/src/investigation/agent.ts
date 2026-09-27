import {
  submittedReportSchema,
  type InvestigationEvent,
  type InvestigationReport,
  type InvestigationUsage,
  type SubmittedReport,
} from '@trace-pilot/shared';
import { verifyReport, type ExecutedCall } from './citations';
import type { ChatMessage, ModelClient } from './model';
import {
  DISCLAIMER,
  FINALIZE_INSTRUCTION,
  INVESTIGATION_SYSTEM_PROMPT,
  investigationRequest,
} from './prompt';
import {
  runTool,
  SUBMIT_ONLY_TOOL_SPECS,
  SUBMIT_REPORT_TOOL,
  TOOL_SPECS,
  type ToolContext,
  type ToolResult,
} from './tools';

/**
 * 排障 Agent 的主循环：模型决定调哪些工具 → 执行 → 把结果放回对话 → 再问模型，
 * 直到它调用 submit_report 并通过校验。
 *
 * 循环刻意手写而不用框架：它只有一百多行，而每个上限、每个失败分支都要能讲清楚。
 * 所有上限都是硬性的——模型不收敛时，由这里而不是模型决定何时停下。
 */
export interface InvestigationLimits {
  /** 收集证据阶段最多几轮模型调用；用尽后只允许 submit_report。 */
  maxSteps: number;
  /** 一轮里最多执行几个工具调用，多出的直接告知模型被跳过。 */
  maxToolCallsPerStep: number;
  /** 报告被校验驳回后最多允许重交几次。 */
  maxReportAttempts: number;
  /** 累计输入 token 上限；每轮都会重发整段对话，所以这个数增长得比直觉快。 */
  maxInputTokens: number;
  toolTimeoutMs: number;
}

export const DEFAULT_LIMITS: InvestigationLimits = {
  maxSteps: 8,
  maxToolCallsPerStep: 4,
  maxReportAttempts: 3,
  maxInputTokens: 80_000,
  toolTimeoutMs: 5_000,
};

export class InvestigationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface InvestigateOptions {
  client: ModelClient;
  context: ToolContext;
  issue: { id: string; title: string };
  emit(event: InvestigationEvent): void;
  signal: AbortSignal;
  /** 由调用方持有并在循环中累加，失败或取消时调用方仍能拿到已消耗的量。 */
  usage: InvestigationUsage;
  limits?: Partial<InvestigationLimits>;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = raw.trim() ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    return { unparsed: raw.slice(0, 500) };
  }
}

function withTimeout(task: Promise<ToolResult>, timeoutMs: number): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          output: JSON.stringify({ error: 'TOOL_TIMEOUT', message: 'The tool timed out.' }),
          truncated: false,
        }),
      timeoutMs,
    );
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

interface ReportCheck {
  report?: SubmittedReport;
  evidence?: InvestigationReport['evidence'];
  problems: string[];
}

/** 两层校验：先用共享 Zod Schema 校验形状，再逐条核对引用。任何一层的问题都回给模型修正。 */
function checkReport(raw: string, calls: ReadonlyMap<string, ExecutedCall>): ReportCheck {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { problems: ['submit_report arguments are not valid JSON.'] };
  }
  const parsed = submittedReportSchema.safeParse(value);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || 'report'}: ${issue.message}`),
    };
  }
  const { problems, evidence } = verifyReport(parsed.data, calls);
  return { report: parsed.data, evidence, problems };
}

function finalReport(
  report: SubmittedReport,
  evidence: InvestigationReport['evidence'],
  problems: string[],
  attempts: number,
): InvestigationReport {
  return {
    ...report,
    evidence,
    // 用尽重交次数后仍接受报告，但指向不存在证据的引用会被剔除，界面也会标出未通过的项。
    possibleCauses: report.possibleCauses.map((cause) => ({
      ...cause,
      evidenceRefs: cause.evidenceRefs.filter((ref) => ref < evidence.length),
    })),
    verification: { attempts, allVerified: problems.length === 0, problems },
    disclaimer: DISCLAIMER,
  };
}

export async function investigate(options: InvestigateOptions): Promise<InvestigationReport> {
  const { client, context, issue, emit, signal, usage } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const messages: ChatMessage[] = [
    { role: 'system', content: INVESTIGATION_SYSTEM_PROMPT },
    { role: 'user', content: investigationRequest(issue) },
  ];
  // 本次运行里真实发生过的工具调用；引用校验只认这里的记录。
  const calls = new Map<string, ExecutedCall>();
  let reportAttempts = 0;
  let finalizing = false;

  for (let step = 1; ; step += 1) {
    signal.throwIfAborted();
    if (!finalizing && (step > limits.maxSteps || usage.inputTokens >= limits.maxInputTokens)) {
      finalizing = true;
      messages.push({ role: 'user', content: FINALIZE_INSTRUCTION });
    }
    if (step > limits.maxSteps + limits.maxReportAttempts) {
      throw new InvestigationError(
        'STEP_LIMIT',
        'The model did not submit a valid report within the step budget.',
      );
    }

    emit({ type: 'step.started', step });
    usage.steps = step;
    const turn = await client.complete({
      messages,
      tools: finalizing ? SUBMIT_ONLY_TOOL_SPECS : TOOL_SPECS,
      // 收尾阶段强制调用 submit_report，模型不能再选择继续调查或只回一段文字。
      toolChoice: finalizing ? { name: SUBMIT_REPORT_TOOL } : 'auto',
      signal,
      onTextDelta: (text) => emit({ type: 'text.delta', step, text }),
    });
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;

    messages.push({
      role: 'assistant',
      content: turn.text || null,
      ...(turn.toolCalls.length > 0
        ? {
            tool_calls: turn.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    });

    if (turn.toolCalls.length === 0) {
      messages.push({
        role: 'user',
        content:
          'Continue with the tools and finish by calling submit_report. Plain text is not accepted as a result.',
      });
      continue;
    }

    let executed = 0;
    for (const call of turn.toolCalls) {
      signal.throwIfAborted();
      if (call.name === SUBMIT_REPORT_TOOL) {
        reportAttempts += 1;
        const check = checkReport(call.arguments, calls);
        const lastAttempt = reportAttempts >= limits.maxReportAttempts;
        if (check.report && check.evidence && (check.problems.length === 0 || lastAttempt)) {
          return finalReport(check.report, check.evidence, check.problems, reportAttempts);
        }
        if (lastAttempt) {
          throw new InvestigationError(
            'REPORT_INVALID',
            `The report still failed validation after ${reportAttempts} attempts.`,
          );
        }
        emit({ type: 'report.rejected', step, problems: check.problems });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            error: 'REPORT_REJECTED',
            problems: check.problems,
            instruction: 'Fix every problem and call submit_report again.',
          }),
        });
        continue;
      }

      // 每个 tool_call 都必须有对应的 tool 消息，否则下一轮请求会被接口拒绝；
      // 超出上限或收尾阶段的调用也要回一条「已跳过」。
      if (finalizing || executed >= limits.maxToolCallsPerStep) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            error: 'SKIPPED',
            message: finalizing
              ? 'Only submit_report is available now.'
              : `At most ${limits.maxToolCallsPerStep} tool calls run per step.`,
          }),
        });
        continue;
      }

      executed += 1;
      emit({
        type: 'tool.called',
        step,
        toolCallId: call.id,
        name: call.name,
        args: parseArguments(call.arguments),
      });
      const startedAt = performance.now();
      const result = await withTimeout(
        runTool(call.name, call.arguments, context),
        limits.toolTimeoutMs,
      );
      usage.toolCalls += 1;
      calls.set(call.id, { name: call.name, ok: result.ok, output: result.output });
      emit({
        type: 'tool.completed',
        step,
        toolCallId: call.id,
        ok: result.ok,
        output: result.output,
        truncated: result.truncated,
        durationMs: Math.round(performance.now() - startedAt),
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
    }
  }
}
