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
 * 这是诊断契约冒烟评测：检查结构化输出、证据数量和缓存命中，
 * 不把确定性本地引擎的结果包装成语义质量或模型准确率。
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
};

try {
  seedDemoData(database);
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
