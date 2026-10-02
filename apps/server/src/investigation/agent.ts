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
  CODE_TOOLS,
  runTool,
  SUBMIT_ONLY_TOOL_SPECS,
  SUBMIT_REPORT_TOOL,
  toolSpecsFor,
  type ToolContext,
  type ToolResult,
} from './tools';

/**
 * 排障 Agent 的主循环。
 *
 * 「Agent」在这里的含义：模型不是一次性回答，而是可以反复「调用工具查资料 → 看结果 → 决定下一步」。
 * 工具由我们提供（tools.ts，全部只读），模型只能「请求」调用；真正执行的是这里的代码。
 *
 * 和模型的对话是一个 messages 数组，每一轮都把整个数组发给模型（模型本身不记得上一次请求）：
 *   system     系统提示词：角色、规则、防注入要求（prompt.ts）
 *   user       我们说的话：调查任务、收尾指令、纠错提示
 *   assistant  模型的回复：一段文字，和/或若干个 tool_calls（想调用的工具名 + JSON 参数）
 *   tool       工具执行结果，用 tool_call_id 对应到上面某个 tool_call
 *
 * 循环刻意手写而不用框架：它只有一百多行，而每个上限、每个失败分支都要能讲清楚。
 */

/** 硬性上限。模型不收敛（反复调工具、不交报告）时，由这些数字而不是模型决定何时停下。 */
export interface InvestigationLimits {
  /** 收集证据阶段最多几轮模型调用；用尽后只允许 submit_report。 */
  maxSteps: number;
  /** 一轮里最多执行几个工具调用，多出的直接告知模型被跳过。 */
  maxToolCallsPerStep: number;
  /**
   * 一次调查最多提交几次报告，含第一次。最后一次仍有未核实的引用时，报告形状合法就接受并标出这些引用，
   * 形状不合法则以 REPORT_INVALID 失败。
   */
  maxReportAttempts: number;
  /** 累计输入 token 上限；每轮都会重发整段对话，所以这个数增长得比直觉快。 */
  maxInputTokens: number;
  /** 单个工具的执行超时；超时的工具返回 TOOL_TIMEOUT 错误，循环继续。 */
  toolTimeoutMs: number;
}

export const DEFAULT_LIMITS: InvestigationLimits = {
  maxSteps: 8,
  maxToolCallsPerStep: 4,
  maxReportAttempts: 3,
  maxInputTokens: 80_000,
  toolTimeoutMs: 5_000,
};

/** 调查失败的错误，code 会写进运行记录，并通过 SSE 的 run.failed 事件告诉界面。 */
export class InvestigationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface InvestigateOptions {
  /** 模型客户端：真实模型（model.ts）或离线脚本（localClient.ts），接口相同。 */
  client: ModelClient;
  /** 工具执行时需要的数据库连接、Issue 范围等。 */
  context: ToolContext;
  issue: { id: string; title: string };
  /** 每发生一件事（开始一轮、调用工具、模型输出文字……）就调用一次，由 service.ts 存库并推送给浏览器。 */
  emit(event: InvestigationEvent): void;
  /** 取消信号：用户点取消、总超时或服务关闭时触发，循环在下一个检查点抛错退出。 */
  signal: AbortSignal;
  /** 由调用方持有并在循环中累加，失败或取消时调用方仍能拿到已消耗的量。 */
  usage: InvestigationUsage;
  limits?: Partial<InvestigationLimits>;
}

/** 把模型给的工具参数（JSON 字符串）解析成对象，只用于界面展示；解析失败也不抛错。 */
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

/**
 * 给工具执行加超时：Promise.race 让「工具完成」和「计时器到点」赛跑，谁先到用谁的结果。
 * 超时不会真正中断工具（Promise 无法被外部取消），只是不再等它；finally 清掉计时器。
 */
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

/** 组装最终报告：模型提交的内容 + 服务端整理的证据列表 + 校验结果 + 固定的免责声明。 */
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

/**
 * 跑一次完整调查，返回通过校验的报告。失败时抛错（InvestigationError、模型调用错误等）；
 * signal 被触发（取消、超时、服务关闭）时也会抛错，调用方用 signal.aborted 和 signal.reason 区分原因。
 *
 * 每一轮（step）：
 * 1. 检查是否该收尾（轮数或 token 用完）：收尾后只给模型 submit_report 一个工具，并强制它调用。
 * 2. 把 messages 发给模型，流式拿回文字和 tool_calls。
 * 3. 逐个处理 tool_calls：submit_report 走校验，通过就结束；其余工具执行后把结果追加进 messages。
 * 4. 进入下一轮。
 */
export async function investigate(options: InvestigateOptions): Promise<InvestigationReport> {
  const { client, context, issue, emit, signal, usage } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  // 没有配置仓库时不提供代码类工具，任务说明里告诉模型这一点。
  const toolSpecs = toolSpecsFor(context);
  const hasCodeTools = toolSpecs.some((tool) => CODE_TOOLS.includes(tool.function.name));
  const messages: ChatMessage[] = [
    { role: 'system', content: INVESTIGATION_SYSTEM_PROMPT },
    { role: 'user', content: investigationRequest(issue, { codeTools: hasCodeTools }) },
  ];
  // 本次运行里真实发生过的工具调用，按模型可见的编号（T1、T2……）索引；引用校验只认这里的记录。
  const calls = new Map<string, ExecutedCall>();
  let reportAttempts = 0;
  let finalizing = false;

  for (let step = 1; ; step += 1) {
    // 已被取消时立即抛出 AbortError，结束整个调查。
    signal.throwIfAborted();
    if (!finalizing && (step > limits.maxSteps || usage.inputTokens >= limits.maxInputTokens)) {
      finalizing = true;
      messages.push({ role: 'user', content: FINALIZE_INSTRUCTION });
    }
    // 总轮数的硬上限：收集证据的轮数 + 提交报告的次数。
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
      tools: finalizing ? SUBMIT_ONLY_TOOL_SPECS : toolSpecs,
      // 收尾阶段强制调用 submit_report，模型不能再选择继续调查或只回一段文字。
      toolChoice: finalizing ? { name: SUBMIT_REPORT_TOOL } : 'auto',
      signal,
      onTextDelta: (text) => emit({ type: 'text.delta', step, text }),
    });
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;

    // 模型这一轮的回复要原样放回对话历史，下一轮它才知道自己调过哪些工具。
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

    // 模型只回了文字、没调工具：提醒它继续，结论必须通过 submit_report 提交。
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
        // 校验全部通过就结束；最后一次机会时，只要形状合法也接受（未通过的引用会被标出）。
        if (check.report && check.evidence && (check.problems.length === 0 || lastAttempt)) {
          return finalReport(check.report, check.evidence, check.problems, reportAttempts);
        }
        if (lastAttempt) {
          throw new InvestigationError(
            'REPORT_INVALID',
            `The report still failed validation after ${reportAttempts} attempts.`,
          );
        }
        // 驳回：把具体问题作为这次 tool_call 的结果回给模型，让它下一轮修正后重交。
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
      // 编号写进结果正文的第一行：tool_call_id 只在消息元数据里，模型读不到，没法拿来引用。
      const ref = `T${calls.size + 1}`;
      emit({
        type: 'tool.called',
        step,
        toolCallId: call.id,
        ref,
        name: call.name,
        args: parseArguments(call.arguments),
      });
      const startedAt = performance.now();
      const result = await withTimeout(
        runTool(call.name, call.arguments, context),
        limits.toolTimeoutMs,
      );
      usage.toolCalls += 1;
      calls.set(ref, {
        toolCallId: call.id,
        name: call.name,
        ok: result.ok,
        output: result.output,
      });
      emit({
        type: 'tool.completed',
        step,
        toolCallId: call.id,
        ok: result.ok,
        output: result.output,
        truncated: result.truncated,
        durationMs: Math.round(performance.now() - startedAt),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `ref: ${ref} (${call.name})\n${result.output}`,
      });
    }
  }
}
