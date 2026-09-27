import type { InvestigationReport, SubmittedReport } from '@trace-pilot/shared';

/**
 * 引用校验：模型说「证据 X 来自工具调用 Y，原文是 Z」，这里核对 Y 真的发生过、成功了，
 * 并且 Z 真的出现在 Y 的结果里。这是一个确定性的幻觉检测——不需要第二个模型当裁判。
 *
 * 它能抓到的：编造的调用 id、引用失败的调用、编造或改写过的「原文」、指向不存在证据的原因。
 * 它抓不到的：原文属实但推理错误。那部分靠评测集和人工判断。
 */
export interface ExecutedCall {
  name: string;
  ok: boolean;
  output: string;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/** 收集 JSON 结果里的全部字符串值：模型看到的是转义后的 JSON，引用时却常写成解码后的文字。 */
function decodedText(output: string): string {
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  try {
    visit(JSON.parse(output));
  } catch {
    // 被截断的结果不是合法 JSON，只能按原始文本匹配。
  }
  return parts.join('\n');
}

export function verifyReport(
  report: SubmittedReport,
  calls: ReadonlyMap<string, ExecutedCall>,
): { problems: string[]; evidence: InvestigationReport['evidence'] } {
  const problems: string[] = [];
  const evidence = report.evidence.map((item, index) => {
    const call = calls.get(item.toolCallId);
    let verified = false;
    if (!call) {
      problems.push(
        `evidence[${index}] cites toolCallId "${item.toolCallId}", which was never called.`,
      );
    } else if (!call.ok) {
      problems.push(
        `evidence[${index}] cites a failed ${call.name} call; cite a successful result.`,
      );
    } else {
      const quote = normalize(item.quote);
      const haystack = `${normalize(call.output)}\n${normalize(decodedText(call.output))}`;
      verified = quote.length >= 4 && haystack.includes(quote);
      if (!verified) {
        problems.push(
          `evidence[${index}].quote was not found verbatim in the ${call.name} result (${item.toolCallId}).`,
        );
      }
    }
    return { ...item, verified };
  });
  report.possibleCauses.forEach((cause, index) => {
    const invalid = cause.evidenceRefs.filter((ref) => ref >= report.evidence.length);
    if (invalid.length > 0) {
      problems.push(`possibleCauses[${index}] references missing evidence ${invalid.join(', ')}.`);
    }
  });
  return { problems, evidence };
}
