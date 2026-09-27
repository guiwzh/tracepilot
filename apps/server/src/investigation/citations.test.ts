import { describe, expect, it } from 'vitest';
import type { SubmittedReport } from '@trace-pilot/shared';
import { verifyReport, type ExecutedCall } from './citations';

const detail: ExecutedCall = {
  toolCallId: 'call_00_abc',
  name: 'get_event_detail',
  ok: true,
  output: JSON.stringify({
    message: "Cannot read properties of undefined (reading 'total')",
    timeline: ['-4.1s click button.edit-cart “Edit quantities”', '-3.0s network GET /cart → 200'],
  }),
};

function report(resultRef: string, quote: string): SubmittedReport {
  return {
    summary: 'summary',
    evidence: [{ resultRef, quote, description: 'd', source: 'breadcrumb' }],
    possibleCauses: [{ cause: 'c', confidence: 0.5, evidenceRefs: [0] }],
    investigationSteps: [],
    suggestions: [],
    missingInformation: [],
  };
}

const calls = new Map([['T1', detail]]);

describe('verifyReport', () => {
  it('accepts the ref in the loose forms models tend to write and maps it back to the call', () => {
    for (const ref of ['T1', 't1', '[T1]', 'ref T1']) {
      const { problems, evidence } = verifyReport(report(ref, "reading 'total'"), calls);
      expect(problems).toEqual([]);
      expect(evidence[0]).toMatchObject({
        resultRef: 'T1',
        toolCallId: 'call_00_abc',
        verified: true,
      });
    }
  });

  it('accepts a quote made of several verbatim spans, one per line', () => {
    // 真实模型把时间线里相邻的两项拼成一条引用；每一段都属实，含义没有改变。
    const quote = '-4.1s click button.edit-cart "Edit quantities"\\n-3.0s network GET /cart → 200';
    expect(verifyReport(report('T1', quote), calls).problems).toEqual([]);
  });

  it('rejects a multi-span quote when any span is not in the result', () => {
    const quote = '-4.1s click button.edit-cart\n-3.0s network GET /cart → 500';
    const { problems, evidence } = verifyReport(report('T1', quote), calls);
    expect(evidence[0]!.verified).toBe(false);
    expect(problems[0]).toContain('not found verbatim');
  });

  it('rejects a ref that matches no tool result', () => {
    const { problems, evidence } = verifyReport(report('T9', "reading 'total'"), calls);
    expect(evidence[0]).toMatchObject({ toolCallId: null, verified: false });
    expect(problems[0]).toContain('does not match any tool result');
  });
});
