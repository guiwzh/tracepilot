import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_CASES } from './cases';
import { cohenKappa } from './metrics';
import type { JudgeVerdict } from './scoring';

/**
 * LLM 裁判可信吗？拿人工标注来对。pnpm evaluate:agreement
 *
 *   --template   从评测结果生成待标注文件（已有的人工标注会保留）
 *   （无参数）   读取标注，计算裁判与人工的一致率和 Cohen's kappa，列出分歧
 *   --results=path  评测结果，默认 docs/reports/agent-evaluation.json
 *   --labels=path   标注文件，默认 docs/reports/agent-evaluation-labels.json
 *
 * 标注是「盲评」：文件里只有参考根因和报告内容，没有引擎名和裁判结论，条目顺序也打乱了，
 * 避免标注的人被「这是 Agent 写的」或「裁判说它对」带偏。条目 id 由「用例/引擎/第几次」哈希而来，
 * 计算一致性时再对回去。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const VERDICTS = ['correct', 'partial', 'incorrect'] as const;
type Verdict = (typeof VERDICTS)[number];

interface ResultRow {
  caseId: string;
  engine: string;
  run?: number;
  output?: {
    summary: string;
    causes: Array<{ cause: string; confidence: number }>;
    missingInformation: string[];
  };
  judge?: JudgeVerdict;
}

interface LabelItem {
  id: string;
  reference: string;
  summary: string;
  causesRankedByConfidence: Array<{ cause: string; confidence: number }>;
  missingInformation: string[];
  /** 填 correct / partial / incorrect，标准与裁判提示词相同（见 instructions）。 */
  human: Verdict | null;
  note: string;
}

interface LabelFile {
  instructions: string;
  results: { measuredAt: string; model: string | null; promptVersion: string };
  items: LabelItem[];
}

const INSTRUCTIONS =
  'Grade each candidate against the reference root cause, without looking at the evaluation results. Set "human" to "correct" if the top-ranked cause identifies the same mechanism as the reference; "partial" if it is the right area but the key mechanism is missing, or the right cause appears only below the top rank; "incorrect" otherwise, including confident claims that contradict the reference. Leave null to skip an item.';

function argument(name: string): string | undefined {
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const resultsPath = resolve(
  argument('results') ?? join(repoRoot, 'docs/reports/agent-evaluation.json'),
);
const labelsPath = resolve(
  argument('labels') ?? join(repoRoot, 'docs/reports/agent-evaluation-labels.json'),
);

const keyOf = (row: ResultRow) => `${row.caseId}/${row.engine}/${row.run ?? 1}`;
const idOf = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 10);

const evaluation = JSON.parse(await readFile(resultsPath, 'utf8')) as {
  measuredAt: string;
  model: string | null;
  promptVersion: string;
  results: ResultRow[];
};
const rows = evaluation.results.filter((row) => row.output);
const existing = await readFile(labelsPath, 'utf8')
  .then((text) => JSON.parse(text) as LabelFile)
  .catch(() => null);

if (process.argv.includes('--template')) {
  const previous = new Map(existing?.items.map((item) => [item.id, item]));
  const items = rows
    .map((row): LabelItem => {
      const id = idOf(keyOf(row));
      return {
        id,
        reference: EVAL_CASES.find((item) => item.id === row.caseId)?.reference ?? '',
        summary: row.output!.summary,
        causesRankedByConfidence: [...row.output!.causes].sort(
          (left, right) => right.confidence - left.confidence,
        ),
        missingInformation: row.output!.missingInformation,
        human: previous.get(id)?.human ?? null,
        note: previous.get(id)?.note ?? '',
      };
    })
    // 按 id 排序：顺序与用例、引擎无关，又是确定的，重新生成不会打乱已有的标注。
    .sort((left, right) => left.id.localeCompare(right.id));
  const file: LabelFile = {
    instructions: INSTRUCTIONS,
    results: {
      measuredAt: evaluation.measuredAt,
      model: evaluation.model,
      promptVersion: evaluation.promptVersion,
    },
    items,
  };
  await writeFile(labelsPath, `${JSON.stringify(file, null, 2)}\n`);
  const labeled = items.filter((item) => item.human).length;
  process.stdout.write(`${items.length} 条待标注（已有标注 ${labeled} 条）写入 ${labelsPath}\n`);
} else {
  if (!existing) throw new Error(`没有标注文件 ${labelsPath}：先运行 --template 生成。`);
  const byId = new Map(rows.map((row) => [idOf(keyOf(row)), row]));
  const pairs: Array<{ row: ResultRow; judge: Verdict; human: Verdict }> = [];
  for (const item of existing.items) {
    if (!item.human) continue;
    if (!VERDICTS.includes(item.human)) throw new Error(`${item.id}: 未知的标注 ${item.human}`);
    const row = byId.get(item.id);
    if (row?.judge) pairs.push({ row, judge: row.judge.verdict, human: item.human });
  }
  if (pairs.length === 0) {
    process.stdout.write(
      `还没有可对比的人工标注：在 ${labelsPath} 里填写 human 字段（correct / partial / incorrect）。\n`,
    );
  } else {
    const three = cohenKappa(
      VERDICTS,
      pairs.map(({ judge, human }) => [judge, human] as const),
    );
    // 二分类：只问「是不是正确」，pass^k 用的就是这个口径。
    const binary = cohenKappa(
      ['correct', 'not correct'] as const,
      pairs.map(
        ({ judge, human }) =>
          [
            judge === 'correct' ? 'correct' : 'not correct',
            human === 'correct' ? 'correct' : 'not correct',
          ] as const,
      ),
    );
    const format = (value: number | null) => (value === null ? '—' : value.toFixed(2));
    const lines = [
      `已标注 ${pairs.length} 条（结果来自 ${evaluation.model ?? '无模型'}，${evaluation.measuredAt}）`,
      '',
      '| 口径 | 一致率 | Cohen’s kappa |',
      '| --- | ---: | ---: |',
      `| 三档（正确 / 部分 / 错误） | ${format(three.observed)} | ${format(three.kappa)} |`,
      `| 二档（正确 / 不正确） | ${format(binary.observed)} | ${format(binary.kappa)} |`,
      '',
      '混淆矩阵（行：裁判，列：人工）',
      '',
      '| 裁判 \\ 人工 | correct | partial | incorrect |',
      '| --- | ---: | ---: | ---: |',
      ...VERDICTS.map(
        (judgeVerdict) =>
          `| ${judgeVerdict} | ${VERDICTS.map((human) => three.matrix[judgeVerdict][human]).join(' | ')} |`,
      ),
    ];
    const disagreements = pairs.filter(({ judge, human }) => judge !== human);
    if (disagreements.length > 0) {
      lines.push(
        '',
        '分歧',
        '',
        ...disagreements.map(
          ({ row, judge, human }) =>
            `- ${keyOf(row)}：裁判 ${judge}，人工 ${human}。裁判理由：${row.judge?.reason ?? ''}`,
        ),
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}
