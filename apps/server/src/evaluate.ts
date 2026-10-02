import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosisResultSchema } from '@trace-pilot/shared';
import type { ServerConfig } from './config';
import { createDatabase } from './db/client';
import { diagnoseIssue } from './services/diagnosis';
import { listIssues } from './services/queries';
import { seedDemoData } from './seed';

/**
 * 单次诊断的契约冒烟评测：pnpm evaluate:diagnosis
 *
 * 在临时数据库里灌入演示数据，对每个 Issue 用本地规则引擎诊断两次，检查结构化输出是否合法、
 * 证据数量，以及第二次是否命中缓存。它不衡量诊断的语义质量——那是 eval/ 目录下
 * 带标注用例的评测（pnpm evaluate:agent）要做的事。
 */
const directory = await mkdtemp(join(tmpdir(), 'tracepilot-eval-'));
const database = createDatabase(join(directory, 'eval.db'));
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  databasePath: join(directory, 'eval.db'),
  sourceMapDir: join(directory, 'maps'),
  modelName: 'local-evidence-engine',
  localAgentStepDelayMs: 0,
  agentSourceContext: true,
  ingestRateLimitPerMinute: 6_000,
  spikeProtection: true,
  repositoryRoot: null,
  dashboardUrl: 'http://localhost:4173',
  autoInvestigationsPerDay: 10,
};

try {
  await seedDemoData(database, config.sourceMapDir);
  const issues = listIssues(database, 'demo-project', { page: 1, pageSize: 100 }).items;
  let valid = 0;
  let evidenceItems = 0;
  let causes = 0;
  let cacheHits = 0;
  for (const issue of issues) {
    const diagnosis = await diagnoseIssue(database, config, issue.id);
    if (!diagnosis) continue;
    if (diagnosisResultSchema.safeParse(diagnosis.result).success) valid += 1;
    evidenceItems += diagnosis.result.evidence.length;
    causes += diagnosis.result.possibleCauses.length;
    const cached = await diagnoseIssue(database, config, issue.id);
    if (cached?.cached) cacheHits += 1;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        engine: 'local-evidence-engine',
        samples: issues.length,
        structuredOutputSuccessRate: issues.length ? valid / issues.length : 0,
        cacheHitRateOnUnchangedContext: issues.length ? cacheHits / issues.length : 0,
        averageEvidenceItems: issues.length
          ? Number((evidenceItems / issues.length).toFixed(2))
          : 0,
        averagePossibleCauses: issues.length ? Number((causes / issues.length).toFixed(2)) : 0,
        note: 'This deterministic smoke evaluation checks contracts and evidence presence; it is not a semantic model-quality benchmark.',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  database.close();
  await rm(directory, { recursive: true, force: true });
}
