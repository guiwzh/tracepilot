import { join } from 'node:path';
import type { ServerConfig } from '../config';
import { createDatabase, type TraceDatabase } from '../db/client';
import { buildSourceMap } from '../demo/sourceMaps';
import { investigate } from '../investigation/agent';
import { OpenAICompatibleClient } from '../investigation/model';
import { diagnoseIssue } from '../services/diagnosis';
import { ingestEnvelope } from '../services/events';
import { saveSourceMap } from '../services/sourcemaps';
import type { EvalCase } from './cases';

/**
 * 评测的执行部分：把一个用例写进独立的临时库，再用三种引擎分别诊断，输出统一形状。
 *
 * - rules：本地规则引擎（单次、确定性），是没有模型时的基线；
 * - single：一次模型调用 + 结构化输出，即升级前的诊断方式；
 * - agent：只读工具调用循环。
 */
export type EngineName = 'rules' | 'single' | 'agent';

export interface EngineOutput {
  summary: string;
  causes: Array<{ cause: string; confidence: number }>;
  missingInformation: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls?: number;
  steps?: number;
  citations?: { verified: number; total: number; attempts: number };
}

export interface PreparedCase {
  database: TraceDatabase;
  issueId: string;
  issueTitle: string;
  eventCount: number;
}

export async function prepareCase(evalCase: EvalCase, directory: string): Promise<PreparedCase> {
  const database = createDatabase(join(directory, `${evalCase.id}.db`));
  const now = Date.now();
  database.sqlite
    .prepare('INSERT INTO projects (id, name, dsn_key, created_at) VALUES (?, ?, ?, ?)')
    .run('demo-project', 'Eval shop', 'demo-dsn-key', now);
  // 先按部署时间建 Release：compare_releases 依赖部署时间判断「是不是某次发布之后才出现」。
  for (const release of evalCase.releases) {
    database.sqlite
      .prepare('INSERT INTO releases (id, project_id, version, created_at) VALUES (?, ?, ?, ?)')
      .run(
        `${evalCase.id}-${release.version}`,
        'demo-project',
        release.version,
        now - release.deployedMinutesAgo * 60_000,
      );
  }
  for (let start = 0; start < evalCase.events.length; start += 100) {
    ingestEnvelope(database, {
      dsnKey: 'demo-dsn-key',
      sentAt: now,
      events: evalCase.events.slice(start, start + 100),
    });
  }
  for (const map of evalCase.sourceMaps) {
    await saveSourceMap(
      database,
      join(directory, 'maps', evalCase.id),
      `${evalCase.id}-${map.release}`,
      map.fixture.minifiedFile,
      Buffer.from(buildSourceMap(map.fixture)),
    );
  }
  const issue = database.sqlite
    .prepare(
      'SELECT id, title, event_count FROM issues WHERE title LIKE ? ORDER BY event_count DESC LIMIT 1',
    )
    .get(`%${evalCase.issueTitle}%`) as
    { id: string; title: string; event_count: number } | undefined;
  if (!issue) throw new Error(`Eval case ${evalCase.id} did not produce its target issue`);
  return { database, issueId: issue.id, issueTitle: issue.title, eventCount: issue.event_count };
}

export async function runEngine(
  engine: EngineName,
  prepared: PreparedCase,
  config: ServerConfig,
): Promise<EngineOutput> {
  if (engine === 'rules' || engine === 'single') {
    // rules 就是不带密钥的同一条单次诊断路径；force 跳过缓存，每次都真实执行。
    const engineConfig =
      engine === 'rules' ? { ...config, modelApiKey: undefined, modelApiUrl: undefined } : config;
    const record = await diagnoseIssue(prepared.database, engineConfig, prepared.issueId, true);
    if (!record) throw new Error('issue disappeared');
    return {
      summary: record.result.summary,
      causes: record.result.possibleCauses.map(({ cause, confidence }) => ({ cause, confidence })),
      missingInformation: record.result.missingInformation,
      latencyMs: record.latencyMs,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
    };
  }

  const usage = { inputTokens: 0, outputTokens: 0, steps: 0, toolCalls: 0 };
  const startedAt = performance.now();
  const report = await investigate({
    client: new OpenAICompatibleClient(config),
    context: {
      database: prepared.database,
      issueId: prepared.issueId,
      projectId: 'demo-project',
      allowSourceContext: config.agentSourceContext,
    },
    issue: { id: prepared.issueId, title: prepared.issueTitle },
    emit: () => {},
    signal: AbortSignal.timeout(180_000),
    usage,
  });
  return {
    summary: report.summary,
    causes: report.possibleCauses.map(({ cause, confidence }) => ({ cause, confidence })),
    missingInformation: report.missingInformation,
    latencyMs: Math.round(performance.now() - startedAt),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    toolCalls: usage.toolCalls,
    steps: usage.steps,
    citations: {
      verified: report.evidence.filter((item) => item.verified).length,
      total: report.evidence.length,
      attempts: report.verification.attempts,
    },
  };
}
