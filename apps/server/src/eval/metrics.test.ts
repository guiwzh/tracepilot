import { describe, expect, it } from 'vitest';
import { cohenKappa, passAtK, passHatK } from './metrics';
import { summarizeTrajectory } from './trajectory';

describe('pass^k and pass@k', () => {
  it('reduce to the success rate when k is 1', () => {
    expect(passHatK(3, 2, 1)).toBeCloseTo(2 / 3);
    expect(passAtK(3, 2, 1)).toBeCloseTo(2 / 3);
  });

  it('require every sampled run to succeed for pass^k', () => {
    // 3 次里对 2 次：任取 2 次都对的概率是 C(2,2)/C(3,2) = 1/3；取满 3 次就是 0。
    expect(passHatK(3, 2, 2)).toBeCloseTo(1 / 3);
    expect(passHatK(3, 2, 3)).toBe(0);
    expect(passHatK(3, 3, 3)).toBe(1);
    // 至少一次对：1 − C(1,2)/C(3,2) = 1。
    expect(passAtK(3, 2, 2)).toBe(1);
    expect(passAtK(3, 0, 3)).toBe(0);
  });

  it('rejects impossible trial counts', () => {
    expect(() => passHatK(3, 4, 1)).toThrow(RangeError);
    expect(() => passHatK(3, 1, 4)).toThrow(RangeError);
    expect(() => passAtK(0, 0, 1)).toThrow(RangeError);
  });
});

describe("Cohen's kappa", () => {
  const labels = ['correct', 'partial', 'incorrect'] as const;

  it('is 1 for perfect agreement and discounts chance agreement', () => {
    const perfect = cohenKappa(labels, [
      ['correct', 'correct'],
      ['partial', 'partial'],
      ['incorrect', 'incorrect'],
    ]);
    expect(perfect).toMatchObject({ n: 3, observed: 1, kappa: 1 });

    // 教科书例子：两人各判 50 个样本，一致 35 个（po = 0.7），各自「是」的比例 0.5 与 0.6，
    // pe = 0.5×0.6 + 0.5×0.4 = 0.5，κ = (0.7 − 0.5) / 0.5 = 0.4。
    const pairs = [
      ...Array.from({ length: 20 }, () => ['correct', 'correct'] as const),
      ...Array.from({ length: 5 }, () => ['correct', 'incorrect'] as const),
      ...Array.from({ length: 10 }, () => ['incorrect', 'correct'] as const),
      ...Array.from({ length: 15 }, () => ['incorrect', 'incorrect'] as const),
    ];
    const textbook = cohenKappa(labels, pairs);
    expect(textbook.observed).toBeCloseTo(0.7);
    expect(textbook.kappa).toBeCloseTo(0.4);
    expect(textbook.matrix.correct.incorrect).toBe(5);
    expect(textbook.matrix.incorrect.correct).toBe(10);
  });

  it('is undefined when both raters only ever use one label', () => {
    expect(
      cohenKappa(labels, [
        ['correct', 'correct'],
        ['correct', 'correct'],
      ]).kappa,
    ).toBeNull();
    expect(cohenKappa(labels, [])).toMatchObject({ n: 0, kappa: null });
  });
});

describe('trajectory metrics', () => {
  it('counts redundant, failed and rejected work and the evidence the agent never saw', () => {
    const trajectory = summarizeTrajectory(
      [
        { type: 'step.started', step: 1 },
        {
          type: 'tool.called',
          step: 1,
          toolCallId: 'a',
          ref: 'T1',
          name: 'get_event_detail',
          args: { eventId: 'e1' },
        },
        {
          type: 'tool.completed',
          step: 1,
          toolCallId: 'a',
          ok: true,
          output: '{}',
          truncated: false,
          durationMs: 1,
        },
        {
          type: 'tool.called',
          step: 1,
          toolCallId: 'b',
          ref: 'T2',
          name: 'get_source_context',
          args: { eventId: 'nope', frameIndex: 0 },
        },
        {
          type: 'tool.completed',
          step: 1,
          toolCallId: 'b',
          ok: false,
          output: '{"error":"EVENT_NOT_FOUND"}',
          truncated: false,
          durationMs: 1,
        },
        { type: 'step.started', step: 2 },
        // 参数的键顺序不同，仍是同一次调用。
        {
          type: 'tool.called',
          step: 2,
          toolCallId: 'c',
          ref: 'T3',
          name: 'get_source_context',
          args: { frameIndex: 0, eventId: 'nope' },
        },
        {
          type: 'tool.completed',
          step: 2,
          toolCallId: 'c',
          ok: false,
          output: '{"error":"EVENT_NOT_FOUND"}',
          truncated: false,
          durationMs: 1,
        },
        { type: 'step.started', step: 3 },
        { type: 'report.rejected', step: 3, problems: ['evidence[0].quote was not found in T1'] },
      ],
      ['get_event_detail', 'get_source_context'],
    );
    expect(trajectory).toMatchObject({
      steps: 3,
      redundantCalls: 1,
      failedCalls: 2,
      rejectedReports: 1,
      evidenceToolRecall: 0.5,
      missedEvidenceTools: ['get_source_context'],
    });
    expect(trajectory.calls.map((call) => call.ref)).toEqual(['T1', 'T2', 'T3']);
    expect(trajectory.calls[1]!.outputDigest).toBe(trajectory.calls[2]!.outputDigest);
  });
});
