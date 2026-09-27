import type { InvestigationReport, SubmittedReport } from '@trace-pilot/shared';

/**
 * 引用校验：模型说「证据 X 来自工具结果 T3，原文是 Z」，这里核对 T3 真的发生过、成功了，
 * 并且 Z 真的出现在 T3 的结果里。这是一个确定性的幻觉检测——不需要第二个模型当裁判。
 *
 * 它能抓到的：编造的编号、引用失败的调用、编造或改写过的「原文」、指向不存在证据的原因。
 * 它抓不到的：原文属实但推理错误。那部分靠评测集和人工判断。
 */
export interface ExecutedCall {
  toolCallId: string;
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

/** 模型常写 "t3"、"[T3]"、"ref T3"，都归一成 T3。 */
export function normalizeRef(value: string): string {
  const match = /t\s*(\d{1,4})/i.exec(value);
  return match ? `T${Number(match[1])}` : value.trim();
}

/**
 * 原文可以由几段组成（例如时间线里相邻的两行），用换行或省略号分隔，每一段都必须逐字出现。
 * 把两段各自属实的原文拼在一起并不改变含义；但只要有一段对不上，整条引用就不算核实。
 */
function quoteSegments(quote: string): string[] {
  return quote
    .split(/\\n|\n|…|\.\.\./)
    .map((segment) => normalize(segment))
    .filter((segment) => segment.length > 0);
}

export function verifyReport(
  report: SubmittedReport,
  calls: ReadonlyMap<string, ExecutedCall>,
): { problems: string[]; evidence: InvestigationReport['evidence'] } {
  const problems: string[] = [];
  const evidence = report.evidence.map((item, index) => {
    const ref = normalizeRef(item.resultRef);
    const call = calls.get(ref);
    let verified = false;
    if (!call) {
      problems.push(
        `evidence[${index}] cites resultRef "${item.resultRef}", which does not match any tool result. Use the ref printed on the first line of a result, such as T1.`,
      );
    } else if (!call.ok) {
      problems.push(
        `evidence[${index}] cites ${ref}, a failed ${call.name} call; cite a successful result.`,
      );
    } else {
      const haystack = `${normalize(call.output)}\n${normalize(decodedText(call.output))}`;
      const segments = quoteSegments(item.quote);
      verified =
        segments.length > 0 &&
        segments.some((segment) => segment.length >= 8) &&
        segments.every((segment) => haystack.includes(segment));
      if (!verified) {
        problems.push(
          `evidence[${index}].quote was not found verbatim in ${ref} (${call.name}). Copy a short span exactly as it appears.`,
        );
      }
    }
    return { ...item, resultRef: ref, toolCallId: call?.toolCallId ?? null, verified };
  });
  report.possibleCauses.forEach((cause, index) => {
    const invalid = cause.evidenceRefs.filter((ref) => ref >= report.evidence.length);
    if (invalid.length > 0) {
      problems.push(`possibleCauses[${index}] references missing evidence ${invalid.join(', ')}.`);
    }
  });
  return { problems, evidence };
}
