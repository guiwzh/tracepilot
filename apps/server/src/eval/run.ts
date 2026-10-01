import 'dotenv/config';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { OpenAICompatibleClient } from '../investigation/model';
import { INVESTIGATION_PROMPT_VERSION } from '../investigation/prompt';
import { EVAL_CASES, type EvalCase } from './cases';
import {
  compareOutcomes,
  outcomeOf,
  readCassette,
  RECORDINGS_DIR,
  RecordingClient,
  ReplayClient,
  toolsDigest,
  writeCassette,
  type Cassette,
  type CassetteRun,
} from './cassette';
import {
  EngineRunError,
  MODEL_ENGINES,
  prepareCase,
  runEngine,
  type EngineName,
  type EngineOutput,
} from './harness';
import { passAtK, passHatK } from './metrics';
import {
  judge,
  judgeConfig,
  scoreDeterministic,
  type DeterministicScore,
  type JudgeVerdict,
} from './scoring';
import type { Trajectory } from './trajectory';

/**
 * 诊断评测：pnpm evaluate:agent
 *
 * 引擎：rules（规则）、agent-local（离线脚本驱动的 Agent）、single（单次模型调用）、agent（模型驱动的 Agent）。
 * 没有 MODEL_API_KEY 时默认只跑前两个；配置密钥后四个都跑，并由 LLM 裁判复核。
 *
 *   --engines=rules,agent-local,single,agent
 *   --cases=id1,id2
 *   --runs=3        模型引擎每个用例重复几次（默认 3），据此算 pass^k；确定性引擎只跑一次
 *   --record        把 agent 每次运行的模型回复录到 src/eval/recordings/<模型>/<用例>.json
 *   --replay[=模型] agent 不调用模型，按录制回放：不需要密钥，裁判结论也取录制时的
 *   --rejudge       回放时重新请裁判打分（例如换一个 EVAL_JUDGE_* 裁判复核同一批报告）
 *   --out=path      结果 JSON 的位置。默认只有完整地跑了 agent（全部用例）时才写
 *                   docs/reports/agent-evaluation.json，部分运行不覆盖已提交的报告
 *
 * 控制台输出 Markdown 汇总表。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ENGINES: readonly EngineName[] = ['rules', 'agent-local', 'single', 'agent'];
const config = { ...loadConfig(), localAgentStepDelayMs: 0 };
const hasModel = Boolean(config.modelApiKey && config.modelApiUrl);

function argument(name: string): string[] | undefined {
  const raw = process.argv.find((item) => item.startsWith(`--${name}=`));
  return raw
    ?.slice(name.length + 3)
    .split(',')
    .filter(Boolean);
}
const flag = (name: string) =>
  process.argv.some((item) => item === `--${name}` || item.startsWith(`--${name}=`));

/** --replay 没写模型名时，recordings 下只有一个模型就用它。 */
async function replayModel(): Promise<string> {
  const named = argument('replay')?.[0];
  if (named) return named;
  const models = (await readdir(RECORDINGS_DIR, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (models.length !== 1) {
    throw new Error(
      models.length === 0
        ? '没有录制可以回放：先用 --record 录制。'
        : `有多个模型的录制（${models.join('、')}），用 --replay=<模型> 指定。`,
    );
  }
  return models[0]!;
}

const replay = flag('replay');
const record = flag('record');
const rejudge = flag('rejudge');
if (replay && record) throw new Error('--record 与 --replay 不能同时使用。');
if (record && !hasModel) throw new Error('--record 需要在 apps/server/.env 配置模型密钥。');

const engines = (argument('engines') ??
  (hasModel
    ? [...ENGINES]
    : replay
      ? ['rules', 'agent-local', 'agent']
      : ['rules', 'agent-local'])) as EngineName[];
for (const engine of engines) {
  if (!ENGINES.includes(engine)) throw new Error(`未知引擎：${engine}`);
  if (!hasModel && MODEL_ENGINES.includes(engine) && !(replay && engine === 'agent')) {
    throw new Error(`${engine} 需要在 apps/server/.env 配置 MODEL_API_KEY 与 MODEL_API_URL。`);
  }
}
const runsPerCase = Number(argument('runs')?.[0] ?? 3);
if (!Number.isInteger(runsPerCase) || runsPerCase < 1 || runsPerCase > 10) {
  throw new Error('--runs 取 1 到 10 之间的整数。');
}
const selected = argument('cases');
const unknown = selected?.filter((id) => !EVAL_CASES.some((item) => item.id === id)) ?? [];
if (unknown.length > 0) {
  throw new Error(
    `没有这些用例：${unknown.join('、')}。可选：${EVAL_CASES.map((item) => item.id).join('、')}`,
  );
}
const cases = EVAL_CASES.filter((item) => !selected || selected.includes(item.id));
const recordingModel = replay ? await replayModel() : config.modelName;
const judging = hasModel ? judgeConfig(config) : null;

interface RunResult {
  caseId: string;
  category: EvalCase['category'];
  engine: EngineName;
  /** 同一个用例、同一个引擎的第几次运行（从 1 开始）。 */
  run: number;
  output?: Omit<EngineOutput, 'trajectory'>;
  trajectory?: Trajectory;
  error?: { code: string; message: string };
  score?: DeterministicScore;
  judge?: JudgeVerdict;
  judgeError?: string;
  /** 回放时与录制结果的行为差异，空数组表示一致。 */
  replayDifferences?: string[];
}

const results: RunResult[] = [];
const replayNotes: string[] = [];
const directory = await mkdtemp(join(tmpdir(), 'tracepilot-agent-eval-'));
try {
  for (const evalCase of cases) {
    const cassette =
      replay && engines.includes('agent') ? await readCassette(recordingModel, evalCase.id) : null;
    if (cassette && cassette.promptVersion !== INVESTIGATION_PROMPT_VERSION) {
      replayNotes.push(
        `${evalCase.id}: 录制于提示词 ${cassette.promptVersion}，当前是 ${INVESTIGATION_PROMPT_VERSION}`,
      );
    } else if (cassette && cassette.toolsDigest !== toolsDigest()) {
      replayNotes.push(`${evalCase.id}: 录制之后工具清单（名字、说明或参数）改过`);
    }
    const recordedRuns: CassetteRun[] = [];

    for (const engine of engines) {
      const replaying = replay && engine === 'agent';
      if (replaying && !cassette) {
        results.push({
          caseId: evalCase.id,
          category: evalCase.category,
          engine,
          run: 1,
          error: { code: 'NO_RECORDING', message: `${recordingModel} 没有这个用例的录制。` },
        });
        replayNotes.push(`${evalCase.id}: 没有 ${recordingModel} 的录制，不计入结果`);
        continue;
      }
      const runs = replaying
        ? cassette!.runs.length
        : MODEL_ENGINES.includes(engine)
          ? runsPerCase
          : 1;
      for (let run = 1; run <= runs; run += 1) {
        const recorded = replaying ? cassette!.runs[run - 1]! : null;
        // 每次运行一个全新的库，互不影响（单次诊断会写缓存行）。
        const prepared = await prepareCase(
          evalCase,
          join(directory, engine, String(run)),
          recorded?.clock,
        );
        const recorder =
          record && engine === 'agent'
            ? new RecordingClient(new OpenAICompatibleClient(config))
            : null;
        const result: RunResult = {
          caseId: evalCase.id,
          category: evalCase.category,
          engine,
          run,
        };
        try {
          const { trajectory, ...output } = await runEngine(
            engine,
            prepared,
            recorded ? { ...config, agentSourceContext: cassette!.sourceContext } : config,
            {
              client: recorded
                ? new ReplayClient(cassette!.model, recorded.turns)
                : (recorder ?? undefined),
              evidenceTools: evalCase.evidenceTools,
            },
          );
          result.output = output;
          result.trajectory = trajectory;
          result.score = scoreDeterministic(evalCase, output, prepared.issueTitle);
        } catch (error) {
          if (error instanceof EngineRunError) {
            result.error = { code: error.code, message: error.message.slice(0, 300) };
            result.trajectory = error.trajectory;
          } else {
            result.error = {
              code: 'ERROR',
              message: error instanceof Error ? error.message.slice(0, 300) : String(error),
            };
          }
        } finally {
          prepared.database.close();
        }

        if (result.output) {
          if (recorded && !rejudge) {
            result.judge = recorded.judge ?? undefined;
          } else if (judging) {
            try {
              result.judge = await judge(judging, evalCase, result.output);
            } catch (error) {
              result.judgeError =
                error instanceof Error ? error.message.slice(0, 200) : String(error);
            }
          }
        }
        const outcome =
          result.trajectory &&
          outcomeOf(
            result.trajectory,
            result.output?.citations ?? null,
            result.error?.code ?? null,
          );
        if (recorded && outcome) {
          const { differences, drift } = compareOutcomes(recorded.outcome, outcome);
          result.replayDifferences = differences;
          if (drift.length > 0) {
            replayNotes.push(`${evalCase.id} #${run}: 工具输出与录制时不同：${drift.join('、')}`);
          }
        }
        if (recorder && outcome) {
          recordedRuns.push({
            run,
            clock: prepared.clock,
            turns: recorder.turns,
            outcome,
            score: result.score ?? null,
            judge: result.judge ?? null,
            latencyMs: result.output?.latencyMs ?? 0,
          });
        }
        results.push(result);
        process.stderr.write(
          `${evalCase.id.padEnd(30)} ${engine.padEnd(11)} #${run} ${
            result.error
              ? `ERROR ${result.error.code} ${result.error.message}`
              : `keyword=${result.score?.keywordCorrect} judge=${result.judge?.verdict ?? '-'}${
                  result.trajectory ? ` tools=${result.trajectory.calls.length}` : ''
                }${result.replayDifferences?.length ? ' REPLAY MISMATCH' : ''}`
          }\n`,
        );
      }
    }

    if (record && recordedRuns.length > 0) {
      const cassetteFile: Cassette = {
        format: 1,
        caseId: evalCase.id,
        model: config.modelName,
        promptVersion: INVESTIGATION_PROMPT_VERSION,
        toolsDigest: toolsDigest(),
        sourceContext: config.agentSourceContext,
        recordedAt: new Date().toISOString(),
        runs: recordedRuns,
      };
      await writeCassette(cassetteFile);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 汇总

const round = (value: number | null, digits = 3) =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const mean = (values: number[]) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** 裁判分：正确 1、部分 0.5、错误 0；没交出报告的运行记 0；裁判自己出错的不计入。 */
function judgeValue(row: RunResult): number | undefined {
  if (row.error) return 0;
  if (!row.judge) return undefined;
  return row.judge.verdict === 'correct' ? 1 : row.judge.verdict === 'partial' ? 0.5 : 0;
}

function summarize(engine: EngineName) {
  // 回放时没有录制的用例没有运行过，不算失败，也不计入任何比例。
  const rows = results.filter((row) => row.engine === engine && row.error?.code !== 'NO_RECORDING');
  const byCase = cases
    .map((evalCase) => rows.filter((row) => row.caseId === evalCase.id))
    .filter((group) => group.length > 0);
  // 每个用例跑了 n 次；k 取所有用例里最少的那个 n，pass^k 在用例之间才可比。
  const k = byCase.length > 0 ? Math.min(...byCase.map((group) => group.length)) : 0;
  const passes = (success: (row: RunResult) => boolean) => ({
    pass1: round(mean(byCase.map((group) => group.filter(success).length / group.length))),
    passK:
      k > 1
        ? round(
            mean(byCase.map((group) => passHatK(group.length, group.filter(success).length, k))),
          )
        : null,
    passAtK:
      k > 1
        ? round(mean(byCase.map((group) => passAtK(group.length, group.filter(success).length, k))))
        : null,
  });
  const keywordOk = (row: RunResult) => row.score?.keywordCorrect === true;
  const judgedRows = rows.filter((row) => judgeValue(row) !== undefined);
  const judged = rows.some((row) => row.judge);
  const ok = rows.filter((row) => row.output && row.score);
  const runNumbers = [...new Set(rows.map((row) => row.run))].sort((a, b) => a - b);
  const forbiddenRows = ok.filter((row) => row.score!.adoptedForbidden !== null);
  const missingRows = ok.filter((row) => row.score!.reportedMissing !== null);
  const forbiddenCases = new Set(
    EVAL_CASES.filter((item) => item.forbidden).map((item) => item.id),
  );
  const withTrajectory = rows.filter((row) => row.trajectory);
  const totalCalls = sum(withTrajectory.map((row) => row.trajectory!.calls.length));
  const cited = ok.filter((row) => row.output!.citations);

  return {
    engine,
    cases: byCase.length,
    runsPerCase: k,
    attempts: rows.length,
    failures: rows.filter((row) => row.error).length,
    keyword: {
      ...passes(keywordOk),
      byRun: runNumbers.map((run) => {
        const group = rows.filter((row) => row.run === run);
        return round(group.filter(keywordOk).length / group.length);
      }),
    },
    judge: judged
      ? {
          score: round(mean(judgedRows.map((row) => judgeValue(row)!))),
          ...passes((row) => row.judge?.verdict === 'correct'),
          byRun: runNumbers.map((run) =>
            round(mean(judgedRows.filter((row) => row.run === run).map((row) => judgeValue(row)!))),
          ),
          verdicts: {
            correct: rows.filter((row) => row.judge?.verdict === 'correct').length,
            partial: rows.filter((row) => row.judge?.verdict === 'partial').length,
            incorrect: rows.filter((row) => row.judge?.verdict === 'incorrect').length,
            noReport: rows.filter((row) => row.error).length,
          },
          unjudged: rows.filter((row) => row.judgeError).length,
          adoptedForbidden: `${rows.filter((row) => row.judge?.adoptedForbiddenClaim).length}/${rows.filter((row) => row.judge && forbiddenCases.has(row.caseId)).length}`,
        }
      : null,
    adoptedForbidden: `${forbiddenRows.filter((row) => row.score!.adoptedForbidden).length}/${forbiddenRows.length}`,
    reportedMissing: `${missingRows.filter((row) => row.score!.reportedMissing).length}/${missingRows.length}`,
    citationValidity: cited.length
      ? round(
          sum(cited.map((row) => row.output!.citations!.verified)) /
            sum(cited.map((row) => row.output!.citations!.total)),
        )
      : null,
    trajectory: withTrajectory.length
      ? {
          meanToolCalls: round(mean(withTrajectory.map((row) => row.trajectory!.calls.length)), 1),
          meanSteps: round(mean(withTrajectory.map((row) => row.trajectory!.steps)), 1),
          redundantCallShare: totalCalls
            ? round(sum(withTrajectory.map((row) => row.trajectory!.redundantCalls)) / totalCalls)
            : null,
          failedCallShare: totalCalls
            ? round(sum(withTrajectory.map((row) => row.trajectory!.failedCalls)) / totalCalls)
            : null,
          runsWithRejectedReport: `${withTrajectory.filter((row) => row.trajectory!.rejectedReports > 0).length}/${withTrajectory.length}`,
          evidenceToolRecall: round(
            mean(
              withTrajectory
                .map((row) => row.trajectory!.evidenceToolRecall)
                .filter((value): value is number => value !== null),
            ),
          ),
        }
      : null,
    cost: {
      meanLatencyMs: round(mean(ok.map((row) => row.output!.latencyMs)), 0),
      meanInputTokens: round(mean(ok.map((row) => row.output!.inputTokens)), 0),
      meanOutputTokens: round(mean(ok.map((row) => row.output!.outputTokens)), 0),
    },
    replayMismatches: rows.filter((row) => row.replayDifferences?.length).length,
  };
}

const summary = engines.map(summarize);
const report = {
  measuredAt: new Date().toISOString(),
  mode: replay ? 'replay' : 'live',
  model: replay ? recordingModel : hasModel ? config.modelName : null,
  judge:
    replay && !rejudge
      ? 'recorded'
      : judging
        ? { model: judging.model, sameVendor: judging.sameVendor }
        : null,
  promptVersion: INVESTIGATION_PROMPT_VERSION,
  toolsDigest: toolsDigest(),
  cases: cases.length,
  runsPerCase,
  note: '12 个虚构用例的小样本评测。关键词评分粗糙但可复现；LLM 裁判与被测模型同源时存在偏差。agent-local 是离线脚本，不是模型推理。',
  replayNotes,
  summary,
  results,
};

const outArgument = argument('out')?.[0];
const outPath = outArgument
  ? resolve(outArgument)
  : engines.includes('agent') && !selected
    ? join(repoRoot, 'docs/reports/agent-evaluation.json')
    : null;
if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

const cell = (value: unknown) => (value === null || value === undefined ? '—' : String(value));
const range = (values: Array<number | null>) => {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length > 1 ? `${Math.min(...defined)}–${Math.max(...defined)}` : '—';
};
const lines = [
  '结论',
  '',
  '| 引擎 | 次数/用例 | 关键词 pass@1 | 关键词 pass^k | 裁判得分 | 裁判正确 pass@1 | 裁判正确 pass^k | 各轮裁判得分 | 采纳注入/误导（裁判） | 提到缺失信息 | 失败 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...summary.map(
    (row) =>
      `| ${row.engine} | ${row.runsPerCase} | ${cell(row.keyword.pass1)} | ${cell(row.keyword.passK)} | ${cell(row.judge?.score)} | ${cell(row.judge?.pass1)} | ${cell(row.judge?.passK)} | ${row.judge ? range(row.judge.byRun) : '—'} | ${cell(row.judge?.adoptedForbidden)} | ${row.reportedMissing} | ${row.failures} |`,
  ),
  '',
  '过程与成本',
  '',
  '| 引擎 | 引用有效率 | 平均工具调用 | 重复调用占比 | 失败调用占比 | 有报告被驳回的运行 | 关键证据工具召回 | 平均耗时 ms | 平均输入 token | 平均输出 token |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...summary.map(
    (row) =>
      `| ${row.engine} | ${cell(row.citationValidity)} | ${cell(row.trajectory?.meanToolCalls)} | ${cell(row.trajectory?.redundantCallShare)} | ${cell(row.trajectory?.failedCallShare)} | ${cell(row.trajectory?.runsWithRejectedReport)} | ${cell(row.trajectory?.evidenceToolRecall)} | ${cell(row.cost.meanLatencyMs)} | ${cell(row.cost.meanInputTokens)} | ${cell(row.cost.meanOutputTokens)} |`,
  ),
];
if (replayNotes.length > 0)
  lines.push('', '回放提示', '', ...replayNotes.map((note) => `- ${note}`));
const mismatches = summary.reduce((total, row) => total + row.replayMismatches, 0);
if (mismatches > 0)
  lines.push('', `回放与录制不一致的运行：${mismatches}（见结果 JSON 的 replayDifferences）`);
if (outPath) lines.push('', `结果写入 ${outPath}`);
process.stdout.write(`${lines.join('\n')}\n`);
