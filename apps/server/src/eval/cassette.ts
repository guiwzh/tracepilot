import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelClient, ModelRequest, ModelTurn } from '../investigation/model';
import { TOOL_SPECS } from '../investigation/tools';
import type { DeterministicScore, JudgeVerdict } from './scoring';
import type { Trajectory } from './trajectory';

/**
 * 录制与回放（record / replay）。
 *
 * 真实模型的评测要密钥、要花钱、每次结果还不一样，没法放进 CI。录制模式把模型每一轮的回复
 * （文字 + 工具调用 + 用量）存成「录像带」（cassette）；回放模式用 ReplayClient 按原顺序把这些回复
 * 交还给 Agent 循环，工具、引用核对、预算这些我们自己的代码照常真实执行。
 *
 * 回放能发现的问题：改了工具的输出格式，模型当时逐字引用的原文对不上了；改了循环或校验逻辑，
 * 同样的模型决策走出了不同的步数或结果。这些都不需要密钥，CI 每次都跑（replay.test.ts）。
 * 回放不能回答「换了提示词以后模型会怎么做」——那需要重新录制。
 *
 * 和前端测试里的 MSW、Polly.js 录制 HTTP 响应是一个思路，只是录的是模型这一层的回复。
 */

export const RECORDINGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'recordings');

/** 一次运行在录制时的结果。回放后逐项对比，任何一项不同都说明我们的代码行为变了。 */
export interface ReplayOutcome {
  steps: number;
  /** 每次工具调用的名字、是否成功和结果摘要（outputDigest 只用于定位差异，不参与相等比较）。 */
  calls: Array<{ ref: string; name: string; ok: boolean; outputDigest: string }>;
  /** 报告里的引用核对结果；调查失败时为 null。 */
  citations: { verified: number; total: number; attempts: number } | null;
  /** 调查失败时的错误码（例如 STEP_LIMIT）。 */
  error: string | null;
}

export interface CassetteRun {
  run: number;
  /**
   * 准备用例数据用的时钟（毫秒时间戳）。数据里的时间都由它推出（见 cases.ts 的 CASES_CLOCK），
   * 回放时用同一个时钟准备数据、并把 Date 固定在这一刻，工具结果才能和录制时逐字一致。
   */
  clock: number;
  turns: ModelTurn[];
  outcome: ReplayOutcome;
  /** 录制时的评分，回放模式直接复用，不需要密钥就能复现整张结果表。 */
  score: DeterministicScore | null;
  judge: JudgeVerdict | null;
  latencyMs: number;
}

export interface Cassette {
  format: 1;
  caseId: string;
  model: string;
  promptVersion: string;
  /** 录制时发给模型的工具清单（名字、说明、参数 Schema）的摘要；和当前不同说明录制已经过时。 */
  toolsDigest: string;
  /** 录制时是否允许把源码发给模型（AGENT_SOURCE_CONTEXT），回放必须一致。 */
  sourceContext: boolean;
  recordedAt: string;
  runs: CassetteRun[];
}

export function toolsDigest(): string {
  return createHash('sha256').update(JSON.stringify(TOOL_SPECS)).digest('hex').slice(0, 16);
}

/** 包在真实客户端外面，原样转发并记下每一轮回复。 */
export class RecordingClient implements ModelClient {
  readonly engine: ModelClient['engine'];
  readonly model: string;
  readonly turns: ModelTurn[] = [];

  constructor(private readonly inner: ModelClient) {
    this.engine = inner.engine;
    this.model = inner.model;
  }

  async complete(request: ModelRequest): Promise<ModelTurn> {
    const turn = await this.inner.complete(request);
    this.turns.push(structuredClone(turn));
    return turn;
  }
}

export class ReplayError extends Error {}

/** 按录制顺序交还模型回复。循环要的轮数比录制的多，说明行为已经和录制时不同。 */
export class ReplayClient implements ModelClient {
  readonly engine = 'model' as const;
  private next = 0;

  constructor(
    readonly model: string,
    private readonly turns: readonly ModelTurn[],
  ) {}

  async complete(request: ModelRequest): Promise<ModelTurn> {
    request.signal.throwIfAborted();
    const turn = this.turns[this.next];
    if (!turn) {
      throw new ReplayError(
        `The loop asked for turn ${this.next + 1}, but the recording has only ${this.turns.length}.`,
      );
    }
    this.next += 1;
    if (turn.text) request.onTextDelta(turn.text);
    return structuredClone(turn);
  }
}

export function outcomeOf(
  trajectory: Trajectory,
  citations: ReplayOutcome['citations'],
  error: string | null,
): ReplayOutcome {
  return {
    steps: trajectory.steps,
    calls: trajectory.calls.map(({ ref, name, ok, outputDigest }) => ({
      ref,
      name,
      ok,
      outputDigest,
    })),
    citations,
    error,
  };
}

/** 录制文件的位置：recordings/<模型>/<用例>.json。 */
export function cassettePath(model: string, caseId: string): string {
  return join(RECORDINGS_DIR, model.replace(/[^\w.-]/g, '_'), `${caseId}.json`);
}

export async function writeCassette(cassette: Cassette): Promise<string> {
  const path = cassettePath(cassette.model, cassette.caseId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cassette, null, 2)}\n`);
  return path;
}

export async function readCassette(model: string, caseId: string): Promise<Cassette | null> {
  try {
    return JSON.parse(await readFile(cassettePath(model, caseId), 'utf8')) as Cassette;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** recordings 下的全部录制，按模型、用例排序。 */
export async function listCassettes(): Promise<Cassette[]> {
  const cassettes: Cassette[] = [];
  let models: string[];
  try {
    models = (await readdir(RECORDINGS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return cassettes;
  }
  for (const model of models) {
    const files = (await readdir(join(RECORDINGS_DIR, model)))
      .filter((file) => file.endsWith('.json'))
      .sort();
    for (const file of files) {
      cassettes.push(
        JSON.parse(await readFile(join(RECORDINGS_DIR, model, file), 'utf8')) as Cassette,
      );
    }
  }
  return cassettes;
}

/**
 * 对比录制与回放的结果。differences 是行为差异（步数、调用序列、引用核对、错误码），
 * 任何一项不同都说明我们的代码对同样的模型决策给出了不同的结果；drift 列出名字和顺序都对得上、
 * 但输出内容变了的工具调用——引用仍然通过时它不算失败，只提示录制可能需要更新。
 */
export function compareOutcomes(
  recorded: ReplayOutcome,
  replayed: ReplayOutcome,
): { differences: string[]; drift: string[] } {
  const differences: string[] = [];
  if (recorded.steps !== replayed.steps) {
    differences.push(`steps: recorded ${recorded.steps}, replayed ${replayed.steps}`);
  }
  const sequence = (calls: ReplayOutcome['calls']) =>
    calls.map((call) => `${call.ref} ${call.name} ${call.ok ? 'ok' : 'error'}`).join(', ');
  if (sequence(recorded.calls) !== sequence(replayed.calls)) {
    differences.push(
      `tool calls: recorded [${sequence(recorded.calls)}], replayed [${sequence(replayed.calls)}]`,
    );
  }
  if (JSON.stringify(recorded.citations) !== JSON.stringify(replayed.citations)) {
    differences.push(
      `citations: recorded ${JSON.stringify(recorded.citations)}, replayed ${JSON.stringify(replayed.citations)}`,
    );
  }
  if (recorded.error !== replayed.error) {
    differences.push(`error: recorded ${recorded.error}, replayed ${replayed.error}`);
  }
  const drift = recorded.calls
    .filter((call, index) => {
      const other = replayed.calls[index];
      return other?.name === call.name && other.outputDigest !== call.outputDigest;
    })
    .map((call) => `${call.ref} (${call.name})`);
  return { differences, drift };
}
