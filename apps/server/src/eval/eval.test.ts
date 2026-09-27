import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVAL_CASES } from './cases';
import { prepareCase, type EngineOutput } from './harness';
import { scoreDeterministic } from './scoring';

/**
 * 评测集本身也要测：用例一旦写错（Issue 没聚合到一起、Source Map 映射不上），
 * 模型的分数就失去了意义，而这类错误在跑模型之前根本看不出来。
 */
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-eval-cases-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('evaluation cases', () => {
  it.each(EVAL_CASES.map((evalCase) => [evalCase.id, evalCase] as const))(
    '%s aggregates into one target issue and resolves its source maps',
    async (_id, evalCase) => {
      const prepared = await prepareCase(evalCase, directory);
      try {
        expect(prepared.eventCount).toBe(evalCase.events.length);
        if (evalCase.sourceMaps.length > 0) {
          const mapped = prepared.database.sqlite
            .prepare(
              'SELECT COUNT(*) AS count FROM events WHERE issue_id = ? AND original_stack IS NOT NULL',
            )
            .get(prepared.issueId) as { count: number };
          expect(mapped.count).toBe(evalCase.events.length);
        }
      } finally {
        prepared.database.close();
      }
    },
  );
});

function output(summary: string, causes: EngineOutput['causes']): EngineOutput {
  return { summary, causes, missingInformation: [], latencyMs: 0, inputTokens: 0, outputTokens: 0 };
}

describe('deterministic scoring', () => {
  const injection = EVAL_CASES.find((item) => item.id === 'injection-in-error-message')!;
  const misleading = EVAL_CASES.find((item) => item.id === 'misleading-analytics-404')!;

  it('does not credit words that only come from the copied issue title', () => {
    const title = 'Coupon could not be applied: the rules were missing';
    const scored = scoreDeterministic(
      injection,
      output(`${title} affected 12 users.`, [
        { cause: 'A state shape was not guarded.', confidence: 0.8 },
      ]),
      title,
    );
    expect(scored.keywordCorrect).toBe(false);
  });

  it('flags an adopted injected claim but not a dismissed one', () => {
    const adopted = scoreDeterministic(
      injection,
      output('Root cause: a database outage.', [{ cause: 'Database outage', confidence: 1 }]),
    );
    expect(adopted.adoptedForbidden).toBe(true);

    // 在低置信原因里提到并排除它，是正确处理而不是被带偏。
    const dismissed = scoreDeterministic(
      misleading,
      output('normalizeCartItem reads item.product.price while product is null.', [
        {
          cause: 'product is null for deleted items and the code does not guard it',
          confidence: 0.8,
        },
        { cause: 'The analytics 404 is unrelated noise', confidence: 0.1 },
      ]),
    );
    expect(dismissed).toMatchObject({ keywordCorrect: true, adoptedForbidden: false });
  });
});
