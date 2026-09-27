import { describe, expect, it } from 'vitest';
import type { InvestigationEvent, InvestigationStreamEvent } from '@trace-pilot/shared';
import { initialInvestigationState, investigationReducer } from './reducer';

const at = 1_000;
const record = (seq: number, event: InvestigationEvent): InvestigationStreamEvent => ({
  seq,
  at: at + seq,
  event,
});

const stream: InvestigationStreamEvent[] = [
  record(1, { type: 'run.started', engine: 'local', model: 'local-scripted-investigator' }),
  record(2, { type: 'step.started', step: 1 }),
  record(3, { type: 'text.delta', step: 1, text: 'Starting with ' }),
  record(4, { type: 'text.delta', step: 1, text: 'the overview.' }),
  record(5, {
    type: 'tool.called',
    step: 1,
    toolCallId: 'call_1',
    name: 'get_issue_overview',
    args: {},
  }),
  record(6, {
    type: 'tool.completed',
    step: 1,
    toolCallId: 'call_1',
    ok: true,
    output: '{"issue":{}}',
    truncated: false,
    durationMs: 3,
  }),
];

describe('investigationReducer', () => {
  it('folds the event stream into steps with streamed text and tool calls', () => {
    const state = investigationReducer(initialInvestigationState, {
      type: 'events',
      records: stream,
    });
    expect(state).toMatchObject({ status: 'running', engine: 'local', lastSeq: 6 });
    expect(state.steps).toEqual([
      {
        step: 1,
        text: 'Starting with the overview.',
        rejected: [],
        toolCalls: [
          {
            id: 'call_1',
            name: 'get_issue_overview',
            args: {},
            status: 'ok',
            output: '{"issue":{}}',
            truncated: false,
            durationMs: 3,
          },
        ],
      },
    ]);
  });

  it('ignores events it has already applied when a reconnect replays them', () => {
    // 断线重连时服务端从 Last-Event-ID 之后回放，但实时推送与回放仍可能交叠。
    const first = investigationReducer(initialInvestigationState, {
      type: 'events',
      records: stream.slice(0, 4),
    });
    const replayed = investigationReducer(first, { type: 'events', records: stream.slice(2) });
    expect(replayed.steps[0]!.text).toBe('Starting with the overview.');
    expect(replayed.steps[0]!.toolCalls).toHaveLength(1);
  });

  it('records a rejected report and the terminal failure', () => {
    const state = investigationReducer(initialInvestigationState, {
      type: 'events',
      records: [
        ...stream,
        record(7, { type: 'report.rejected', step: 1, problems: ['quote not found'] }),
        record(8, {
          type: 'run.failed',
          error: 'REPORT_INVALID',
          message: 'still invalid',
          usage: { inputTokens: 1, outputTokens: 1, steps: 1, toolCalls: 1 },
        }),
      ],
    });
    expect(state.steps[0]!.rejected).toEqual([['quote not found']]);
    expect(state).toMatchObject({
      status: 'failed',
      error: { code: 'REPORT_INVALID' },
      finishedAt: at + 8,
    });
  });
});
