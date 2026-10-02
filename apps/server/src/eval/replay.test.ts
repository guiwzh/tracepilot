import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config';
import { LocalScriptedClient } from '../investigation/localClient';
import type { ModelTurn } from '../investigation/model';
import { EVAL_CASES, type EvalCase } from './cases';
import {
  compareOutcomes,
  listCassettes,
  outcomeOf,
  RecordingClient,
  ReplayClient,
  type ReplayOutcome,
} from './cassette';
import { EngineRunError, prepareCase, runEngine } from './harness';

/**
 * 录制回放：用录下来的模型回复驱动当前的 Agent 循环、工具和引用核对，结果必须和录制时一致。
 * 前半部分用离线脚本现场录制，验证机制本身；后半部分回放 recordings/ 下用真实模型录制的文件。
 */
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  databasePath: ':memory:',
  sourceMapDir: '',
  modelName: 'replay',
  localAgentStepDelayMs: 0,
  agentSourceContext: true,
  ingestRateLimitPerMinute: 0,
  spikeProtection: false,
  repositoryRoot: null,
  dashboardUrl: 'http://localhost:4173',
  autoInvestigationsPerDay: 10,
};

let directory: string;
let counter = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-replay-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function replayRun(
  evalCase: EvalCase,
  clock: number,
  model: string,
  turns: readonly ModelTurn[],
  sourceContext = true,
): Promise<ReplayOutcome> {
  counter += 1;
  const prepared = await prepareCase(evalCase, join(directory, String(counter)), clock);
  try {
    const output = await runEngine(
      'agent',
      prepared,
      { ...config, agentSourceContext: sourceContext },
      { client: new ReplayClient(model, turns), evidenceTools: evalCase.evidenceTools },
    );
    return outcomeOf(output.trajectory!, output.citations!, null);
  } catch (error) {
    if (!(error instanceof EngineRunError)) throw error;
    return outcomeOf(error.trajectory, null, error.code);
  } finally {
    prepared.database.close();
  }
}

/** 用离线脚本录一次：返回录到的回复、录制时的时钟和结果。 */
async function recordLocal(evalCase: EvalCase) {
  counter += 1;
  const clock = Date.now() - 3_600_000;
  const prepared = await prepareCase(evalCase, join(directory, String(counter)), clock);
  const recorder = new RecordingClient(new LocalScriptedClient(0));
  try {
    const output = await runEngine('agent-local', prepared, config, {
      client: recorder,
      evidenceTools: evalCase.evidenceTools,
    });
    return {
      clock,
      turns: recorder.turns,
      outcome: outcomeOf(output.trajectory!, output.citations!, null),
    };
  } finally {
    prepared.database.close();
  }
}

describe('record and replay', () => {
  const evalCase = EVAL_CASES.find((item) => item.id === 'null-guard-regression')!;

  it('replays a recording into the same steps, tool results and citation checks', async () => {
    const recorded = await recordLocal(evalCase);
    expect(recorded.outcome.citations).toMatchObject({ attempts: 1 });
    expect(recorded.outcome.calls.length).toBeGreaterThan(3);

    // 同一个时钟准备出来的数据逐字相同：工具输出的摘要一致，没有漂移。
    const replayed = await replayRun(evalCase, recorded.clock, 'local', recorded.turns);
    expect(compareOutcomes(recorded.outcome, replayed)).toEqual({ differences: [], drift: [] });
  });

  it('reports drift when the data behind a tool result changed', async () => {
    const recorded = await recordLocal(evalCase);
    // 换一个时钟：事件时间都变了，带时间的工具结果随之不同，但调用序列和引用核对不受影响。
    const replayed = await replayRun(evalCase, recorded.clock + 60_000, 'local', recorded.turns);
    const { differences, drift } = compareOutcomes(recorded.outcome, replayed);
    expect(differences).toEqual([]);
    expect(drift.length).toBeGreaterThan(0);
  });

  it('catches a quote that no longer matches what the tool returns', async () => {
    const recorded = await recordLocal(evalCase);
    // 相当于改了工具的输出格式：模型当时逐字引用的原文，现在的工具结果里找不到了。
    const turns = structuredClone(recorded.turns);
    const submit = turns.at(-1)!.toolCalls.at(-1)!;
    const report = JSON.parse(submit.arguments) as { evidence: Array<{ quote: string }> };
    report.evidence[0]!.quote = 'text the tool never returned';
    submit.arguments = JSON.stringify(report);

    const replayed = await replayRun(evalCase, recorded.clock, 'local', turns);
    const { differences } = compareOutcomes(recorded.outcome, replayed);
    expect(differences.join('\n')).toMatch(/steps|citations|error/);
  });

  it('fails instead of improvising when the loop needs more turns than were recorded', async () => {
    const recorded = await recordLocal(evalCase);
    const replayed = await replayRun(
      evalCase,
      recorded.clock,
      'local',
      recorded.turns.slice(0, -1),
    );
    expect(replayed.error).toBe('REPLAY_DIVERGED');
  });
});

// 真实模型的录制（pnpm evaluate:agent --record）。没有录制时这一组为空。
const cassettes = await listCassettes();

describe.runIf(cassettes.length > 0)('recorded model runs', () => {
  it.each(
    cassettes.flatMap((cassette) =>
      cassette.runs.map(
        (run) => [`${cassette.model}/${cassette.caseId} #${run.run}`, cassette, run] as const,
      ),
    ),
  )('%s replays with the recorded outcome', async (_name, cassette, run) => {
    const evalCase = EVAL_CASES.find((item) => item.id === cassette.caseId);
    expect(evalCase, `unknown case ${cassette.caseId}`).toBeDefined();
    const replayed = await replayRun(
      evalCase!,
      run.clock,
      cassette.model,
      run.turns,
      cassette.sourceContext,
    );
    const { differences } = compareOutcomes(run.outcome, replayed);
    expect(differences).toEqual([]);
  });
});
