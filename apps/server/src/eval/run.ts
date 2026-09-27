import 'dotenv/config';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { INVESTIGATION_PROMPT_VERSION } from '../investigation/prompt';
import { EVAL_CASES } from './cases';
import { prepareCase, runEngine, type EngineName, type EngineOutput } from './harness';
import { judge, scoreDeterministic, type DeterministicScore, type JudgeVerdict } from './scoring';

/**
 * 诊断评测：pnpm evaluate:agent
 *
 * 没有 MODEL_API_KEY 时只跑规则基线；配置密钥后同时跑单次调用与 Agent，并由 LLM 裁判复核。
 * 可选参数：--engines=rules,single,agent  --cases=id1,id2
 * 结果写入 docs/reports/agent-evaluation.json，控制台输出 Markdown 汇总表。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const config = { ...loadConfig(), localAgentStepDelayMs: 0 };
const hasModel = Boolean(config.modelApiKey && config.modelApiUrl);

function argument(name: string): string[] | undefined {
  const raw = process.argv.find((item) => item.startsWith(`--${name}=`));
  return raw
    ?.slice(name.length + 3)
    .split(',')
    .filter(Boolean);
}

const engines = (argument('engines') ??
  (hasModel ? ['rules', 'single', 'agent'] : ['rules'])) as EngineName[];
if (!hasModel && engines.some((engine) => engine !== 'rules')) {
  throw new Error('single / agent 需要在 apps/server/.env 配置 MODEL_API_KEY 与 MODEL_API_URL。');
}
const selected = argument('cases');
const cases = EVAL_CASES.filter((item) => !selected || selected.includes(item.id));

interface CaseResult {
  caseId: string;
  category: string;
  engine: EngineName;
  output?: EngineOutput;
  error?: string;
  score?: DeterministicScore;
  judge?: JudgeVerdict;
}

const results: CaseResult[] = [];
const directory = await mkdtemp(join(tmpdir(), 'tracepilot-agent-eval-'));
try {
  for (const evalCase of cases) {
    for (const engine of engines) {
      // 每个引擎用一份全新的库，互不影响（单次诊断会写缓存行）。
      const prepared = await prepareCase(evalCase, join(directory, engine));
      const result: CaseResult = { caseId: evalCase.id, category: evalCase.category, engine };
      try {
        result.output = await runEngine(engine, prepared, config);
        result.score = scoreDeterministic(evalCase, result.output, prepared.issueTitle);
        if (hasModel) result.judge = await judge(config, evalCase, result.output);
      } catch (error) {
        result.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
      } finally {
        prepared.database.close();
      }
      results.push(result);
      process.stderr.write(
        `${evalCase.id.padEnd(30)} ${engine.padEnd(6)} ${result.error ? `ERROR ${result.error}` : `keyword=${result.score?.keywordCorrect} judge=${result.judge?.verdict ?? '-'}`}\n`,
      );
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const ratio = (hit: number, total: number) =>
  total === 0 ? null : Number((hit / total).toFixed(3));
const mean = (values: number[]) =>
  values.length === 0
    ? null
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

const summary = engines.map((engine) => {
  const rows = results.filter((row) => row.engine === engine);
  const ok = rows.filter((row) => row.output && row.score);
  const forbiddenRows = ok.filter((row) => row.score!.adoptedForbidden !== null);
  const missingRows = ok.filter((row) => row.score!.reportedMissing !== null);
  const judged = ok.filter((row) => row.judge);
  const citations = ok.filter((row) => row.output!.citations);
  return {
    engine,
    cases: rows.length,
    failures: rows.length - ok.length,
    keywordAccuracy: ratio(ok.filter((row) => row.score!.keywordCorrect).length, rows.length),
    judgeScore: judged.length
      ? ratio(
          judged.reduce(
            (sum, row) =>
              sum +
              (row.judge!.verdict === 'correct' ? 1 : row.judge!.verdict === 'partial' ? 0.5 : 0),
            0,
          ),
          rows.length,
        )
      : null,
    adoptedForbidden: `${forbiddenRows.filter((row) => row.score!.adoptedForbidden).length}/${forbiddenRows.length}`,
    judgeAdoptedForbidden: judged.length
      ? `${judged.filter((row) => row.judge!.adoptedForbiddenClaim).length}/${judged.filter((row) => EVAL_CASES.find((item) => item.id === row.caseId)?.forbidden).length}`
      : null,
    reportedMissing: `${missingRows.filter((row) => row.score!.reportedMissing).length}/${missingRows.length}`,
    citationValidity: citations.length
      ? ratio(
          citations.reduce((sum, row) => sum + row.output!.citations!.verified, 0),
          citations.reduce((sum, row) => sum + row.output!.citations!.total, 0),
        )
      : null,
    meanLatencyMs: mean(ok.map((row) => row.output!.latencyMs)),
    meanInputTokens: mean(ok.map((row) => row.output!.inputTokens)),
    meanOutputTokens: mean(ok.map((row) => row.output!.outputTokens)),
    meanToolCalls: citations.length
      ? mean(citations.map((row) => row.output!.toolCalls ?? 0))
      : null,
  };
});

const report = {
  measuredAt: new Date().toISOString(),
  model: hasModel ? config.modelName : null,
  judgeModel: hasModel ? (process.env.EVAL_JUDGE_MODEL ?? config.modelName) : null,
  promptVersion: INVESTIGATION_PROMPT_VERSION,
  cases: cases.length,
  note: '12 个虚构用例的小样本评测；关键词评分粗糙但可复现，LLM 裁判与被测模型同源时存在偏差。',
  summary,
  results,
};

await writeFile(
  join(repoRoot, 'docs/reports/agent-evaluation.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);

const cell = (value: unknown) => (value === null || value === undefined ? '—' : String(value));
const lines = [
  '| 引擎 | 关键词正确率 | 裁判得分 | 采纳注入/误导（关键词） | 采纳注入/误导（裁判） | 提到缺失信息 | 引用有效率 | 平均耗时 ms | 平均输入 token | 平均工具调用 | 失败 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...summary.map(
    (row) =>
      `| ${row.engine} | ${cell(row.keywordAccuracy)} | ${cell(row.judgeScore)} | ${row.adoptedForbidden} | ${cell(row.judgeAdoptedForbidden)} | ${row.reportedMissing} | ${cell(row.citationValidity)} | ${cell(row.meanLatencyMs)} | ${cell(row.meanInputTokens)} | ${cell(row.meanToolCalls)} | ${row.failures} |`,
  ),
];
process.stdout.write(`${lines.join('\n')}\n`);
