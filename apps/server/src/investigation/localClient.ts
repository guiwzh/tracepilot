import type { SubmittedReport } from '@trace-pilot/shared';
import type { ChatMessage, ModelClient, ModelRequest, ModelTurn } from './model';
import { SUBMIT_REPORT_TOOL } from './tools';

/**
 * 没有配置模型密钥时使用的确定性离线引擎。
 *
 * 它不是模型推理：按固定顺序调用同一批真实工具（概览 → 样本 → 事件详情 + 版本对比 → 源码），
 * 再用规则从工具结果里摘出原文组装报告。它的用途是离线演示和 E2E 测试——
 * 走的是与真实模型完全相同的循环、工具、引用校验和事件流，界面上会明确标注为离线脚本。
 */
interface ToolOutput {
  id: string;
  name: string;
  value: Record<string, unknown>;
}

function collectResults(messages: ChatMessage[]): ToolOutput[] {
  const names = new Map<string, string>();
  const results: ToolOutput[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) {
        if (call.type === 'function') names.set(call.id, call.function.name);
      }
    }
    if (message.role === 'tool' && typeof message.content === 'string') {
      let value: Record<string, unknown> = {};
      try {
        value = JSON.parse(message.content) as Record<string, unknown>;
      } catch {
        // 被截断的结果：只记录调用发生过。
      }
      results.push({
        id: message.tool_call_id,
        name: names.get(message.tool_call_id) ?? '',
        value,
      });
    }
  }
  return results;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
}

const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

export function buildLocalReport(results: ToolOutput[]): SubmittedReport {
  const find = (name: string) =>
    results.find((result) => result.name === name && !result.value.error);
  const overview = find('get_issue_overview');
  const detail = find('get_event_detail');
  const source = find('get_source_context');
  const releases = find('compare_releases');

  const evidence: SubmittedReport['evidence'] = [];
  const add = (item: SubmittedReport['evidence'][number]) => evidence.push(item) - 1;

  const title = String((overview?.value.issue as { title?: string } | undefined)?.title ?? '');
  const errorText = typeof detail?.value.message === 'string' ? detail.value.message : '';
  const stackRef =
    detail && errorText
      ? add({
          toolCallId: detail.id,
          quote: errorText.slice(0, 160),
          description: 'The latest sample failed with this error.',
          source: 'stack',
        })
      : -1;

  const missing: string[] = [];
  let sourceRef = -1;
  if (source?.value.available === true && typeof source.value.snippet === 'string') {
    const errorLine = source.value.snippet.split('\n').find((line) => line.startsWith('>'));
    const code = errorLine?.split('| ').slice(1).join('| ').trim();
    if (code) {
      sourceRef = add({
        toolCallId: source.id,
        quote: code.slice(0, 160),
        description: `The top frame resolves to ${String(source.value.frame)}.`,
        source: 'source',
      });
    }
  } else if (source && typeof source.value.meaning === 'string') {
    missing.push(source.value.meaning);
  }

  const failed = Array.isArray(detail?.value.failedRequests)
    ? (detail!.value.failedRequests as string[])
    : [];
  const networkRef = failed[0]
    ? add({
        toolCallId: detail!.id,
        quote: failed[0].replace(/^[-+]\d+\.\ds\s+/, '').slice(0, 160),
        description: 'A request failed before the error was raised.',
        source: 'network',
      })
    : -1;

  const timeline = Array.isArray(detail?.value.timeline)
    ? (detail!.value.timeline as string[])
    : [];
  const click = [...timeline].reverse().find((line) => line.includes(' click '));
  const clickRef = click
    ? add({
        toolCallId: detail!.id,
        quote: click.replace(/^[-+]\d+\.\ds\s+click\s+/, '').slice(0, 160),
        description: 'The last user action before the error.',
        source: 'breadcrumb',
      })
    : -1;

  const releaseSummary = typeof releases?.value.summary === 'string' ? releases.value.summary : '';
  const releaseRef = releaseSummary
    ? add({
        toolCallId: releases!.id,
        quote: releaseSummary.slice(0, 180),
        description: 'How the issue is distributed across releases.',
        source: 'release',
      })
    : -1;

  const refs = (...values: number[]) => values.filter((value) => value >= 0);
  const lower = `${title} ${errorText}`.toLowerCase();
  const causes: SubmittedReport['possibleCauses'] = [];
  if (networkRef >= 0 || /→\s*5\d\d|request|network/.test(lower)) {
    causes.push({
      cause: 'An upstream request failed and the page surfaced the failure instead of degrading.',
      confidence: 0.7,
      evidenceRefs: refs(networkRef, stackRef),
    });
  }
  if (/resource|chunk|failed to load/.test(lower)) {
    causes.push({
      cause: 'The page referenced a static asset that was missing after a deployment.',
      confidence: 0.65,
      evidenceRefs: refs(stackRef, releaseRef),
    });
  }
  if (/undefined|null|missing|omitted|invalid|non-numeric/.test(lower)) {
    causes.push({
      cause:
        'The code at the top frame assumes a field is always present, but the data it received did not include it.',
      confidence: sourceRef >= 0 ? 0.72 : 0.55,
      evidenceRefs: refs(sourceRef, stackRef, clickRef),
    });
  }
  if (releaseRef >= 0) {
    causes.push({
      cause: 'A release changed the data shape or timing this code path depends on.',
      confidence: 0.4,
      evidenceRefs: refs(releaseRef),
    });
  }
  if (causes.length === 0 || causes.every((cause) => cause.evidenceRefs.length === 0)) {
    causes.unshift({
      cause: 'The failing code path received a state it does not handle.',
      confidence: 0.45,
      evidenceRefs: refs(stackRef, sourceRef, clickRef, releaseRef).slice(0, 1),
    });
  }

  if (evidence.length === 0) {
    // 连一次成功的工具调用都没有时，报告只能引用概览本身。
    evidence.push({
      toolCallId: overview?.id ?? results[0]?.id ?? 'none',
      quote: title.slice(0, 160) || 'issue',
      description: 'The issue title.',
      source: 'issue',
    });
  }
  missing.push('A correlated backend trace or request id for the failing session.');

  const ranked = causes
    .filter((cause) => cause.evidenceRefs.length > 0)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 4);
  const frame = typeof source?.value.frame === 'string' ? ` at ${source.value.frame}` : '';
  return {
    summary: `Most likely${frame}: ${ranked[0]?.cause ?? 'the cause could not be narrowed down.'}`,
    evidence,
    possibleCauses: ranked,
    investigationSteps: [
      'Open the mapped top frame and check which field the code assumes is present.',
      'Compare the failing samples by release before narrowing the cause.',
      'Replay the last captured user action against the same response.',
    ],
    suggestions: [
      'Guard the optional value at the mapped frame and keep the UI in a recoverable state.',
      'Add a test fixture for the data shape that triggered the failure.',
    ],
    missingInformation: missing.slice(0, 6),
  };
}

export class LocalScriptedClient implements ModelClient {
  readonly engine = 'local' as const;
  readonly model = 'local-scripted-investigator';

  constructor(private readonly stepDelayMs = 0) {}

  async complete(request: ModelRequest): Promise<ModelTurn> {
    await sleep(this.stepDelayMs, request.signal);
    const results = collectResults(request.messages);
    const has = (name: string) => results.some((result) => result.name === name);
    const call = (name: string, args: Record<string, unknown>) => ({
      id: `local_${results.length}_${name}`,
      name,
      arguments: JSON.stringify(args),
    });

    let narration: string;
    let toolCalls: ModelTurn['toolCalls'];
    const samples = results.find((result) => result.name === 'list_event_samples')?.value
      .samples as Array<{ eventId: string; stackMapped: boolean }> | undefined;
    const detail = results.find((result) => result.name === 'get_event_detail');
    const forcedSubmit = request.toolChoice !== 'auto';

    if (!forcedSubmit && !has('get_issue_overview')) {
      narration = 'Starting with the issue overview and the most recent samples.';
      toolCalls = [call('get_issue_overview', {}), call('list_event_samples', { limit: 5 })];
    } else if (!forcedSubmit && !detail && samples?.length) {
      const target = samples.find((sample) => sample.stackMapped) ?? samples[0]!;
      narration = `Inspecting event ${target.eventId} and checking how the issue spreads across releases.`;
      toolCalls = [
        call('get_event_detail', { eventId: target.eventId }),
        call('compare_releases', {}),
      ];
    } else if (!forcedSubmit && detail?.value.stack && !has('get_source_context')) {
      narration = 'The event has a stack trace; reading the source around the top frame.';
      toolCalls = [
        call('get_source_context', { eventId: String(detail.value.eventId), frameIndex: 0 }),
      ];
    } else {
      narration = 'Enough evidence gathered; submitting a report that cites each tool result.';
      toolCalls = [call(SUBMIT_REPORT_TOOL, buildLocalReport(results))];
    }

    // 按词分几段转发，让离线演示也走一遍前端的流式渲染路径。
    const words = narration.split(' ');
    for (let index = 0; index < words.length; index += 4) {
      request.onTextDelta(
        `${words.slice(index, index + 4).join(' ')}${index + 4 < words.length ? ' ' : ''}`,
      );
      await sleep(Math.round(this.stepDelayMs / 8), request.signal);
    }
    return {
      text: narration,
      toolCalls,
      usage: {
        inputTokens: estimateTokens(request.messages),
        outputTokens: estimateTokens({ narration, toolCalls }),
      },
    };
  }
}
