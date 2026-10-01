import { join } from 'node:path';
import type { InvestigationEvent, MonitorEvent } from '@trace-pilot/shared';
import type { ServerConfig } from '../config';
import { createDatabase, type TraceDatabase } from '../db/client';
import { buildSourceMap } from '../demo/sourceMaps';
import { investigate, InvestigationError } from '../investigation/agent';
import { LocalScriptedClient } from '../investigation/localClient';
import { OpenAICompatibleClient, type ModelClient } from '../investigation/model';
import { diagnoseIssue } from '../services/diagnosis';
import { ingestEnvelope } from '../services/events';
import { saveSourceMap } from '../services/sourcemaps';
import { CASES_CLOCK, type EvalCase } from './cases';
import { ReplayError } from './cassette';
import { summarizeTrajectory, type Trajectory } from './trajectory';

/**
 * 评测的执行部分：把一个用例写进独立的临时库，再用指定引擎诊断，输出统一形状。
 *
 * - rules：本地规则引擎（单次、确定性），是没有模型时的基线；
 * - agent-local：离线脚本驱动的 Agent 循环（localClient.ts）。工具、引用核对和真实 Agent 完全相同，
 *   只是「下一步调什么」按固定剧本走。不需要密钥，CI 里也能拿到轨迹指标；它不是模型推理，报告里单独列出；
 * - single：一次模型调用 + 结构化输出，即升级前的诊断方式；
 * - agent：真实模型驱动的只读工具调用循环。
 */

export type EngineName = 'rules' | 'agent-local' | 'single' | 'agent';

/** 需要模型密钥的引擎。 */
export const MODEL_ENGINES: readonly EngineName[] = ['single', 'agent'];

/** 各引擎的输出统一成这个形状，评分代码不需要关心结果来自哪个引擎。 */
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
  /** 只有 Agent 类引擎有：调查过程的轨迹指标。 */
  trajectory?: Trajectory;
}

/** Agent 没能交出报告（超出步数、报告始终不合格、模型接口失败……）。带上已经走过的轨迹。 */
export class EngineRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly trajectory: Trajectory,
  ) {
    super(message);
  }
}

export interface PreparedCase {
  database: TraceDatabase;
  issueId: string;
  issueTitle: string;
  eventCount: number;
  /** 准备数据用的时钟，见 prepareCase。 */
  clock: number;
}

/** 把用例里的事件整体平移到给定的时钟：相对时间（几分钟前、breadcrumb 间隔）都不变。 */
function shiftEvents(events: readonly MonitorEvent[], shift: number): MonitorEvent[] {
  if (shift === 0) return [...events];
  return events.map((item) => ({
    ...item,
    timestamp: item.timestamp + shift,
    breadcrumbs: item.breadcrumbs.map((crumb) => ({
      ...crumb,
      timestamp: crumb.timestamp + shift,
    })),
  }));
}

/**
 * 为一个用例建一个独立的 SQLite 文件，走正式的 Source Map 上传和接入代码写入数据，
 * 再找出目标 Issue。每个用例一个库，用例之间互不干扰。
 *
 * clock 是「现在」：事件、版本的部署时间、接入的收到时间都由它推出，库里的数据只取决于它。
 * 回放录制时传入录制时的 clock，工具结果才能与录制时逐字一致。
 */
export async function prepareCase(
  evalCase: EvalCase,
  directory: string,
  clock = Date.now(),
): Promise<PreparedCase> {
  const database = createDatabase(join(directory, `${evalCase.id}.db`));
  database.sqlite
    .prepare('INSERT INTO projects (id, name, dsn_key, created_at) VALUES (?, ?, ?, ?)')
    .run('demo-project', 'Eval shop', 'demo-dsn-key', clock);
  // 先按部署时间建 Release：compare_releases 依赖部署时间判断「是不是某次发布之后才出现」。
  for (const release of evalCase.releases) {
    database.sqlite
      .prepare('INSERT INTO releases (id, project_id, version, created_at) VALUES (?, ?, ?, ?)')
      .run(
        `${evalCase.id}-${release.version}`,
        'demo-project',
        release.version,
        clock - release.deployedMinutesAgo * 60_000,
      );
  }
  // 先上传 map、再接入事件，和推荐的接入方式一致：聚合用的是还原后的栈帧。
  for (const map of evalCase.sourceMaps) {
    await saveSourceMap(
      database,
      join(directory, 'maps', evalCase.id),
      `${evalCase.id}-${map.release}`,
      map.fixture.minifiedFile,
      Buffer.from(buildSourceMap(map.fixture)),
    );
  }
  const events = shiftEvents(evalCase.events, clock - CASES_CLOCK);
  for (let start = 0; start < events.length; start += 100) {
    await ingestEnvelope(
      database,
      { dsnKey: 'demo-dsn-key', sentAt: clock, events: events.slice(start, start + 100) },
      clock,
    );
  }
  const issue = database.sqlite
    .prepare(
      'SELECT id, title, event_count FROM issues WHERE title LIKE ? ORDER BY event_count DESC LIMIT 1',
    )
    .get(`%${evalCase.issueTitle}%`) as
    { id: string; title: string; event_count: number } | undefined;
  if (!issue) throw new Error(`Eval case ${evalCase.id} did not produce its target issue`);
  return {
    database,
    issueId: issue.id,
    issueTitle: issue.title,
    eventCount: issue.event_count,
    clock,
  };
}

export interface RunOptions {
  /** 替换 Agent 用的模型客户端：录制时包一层 RecordingClient，回放时传 ReplayClient。 */
  client?: ModelClient;
  /** 用例标注的关键证据工具，用于轨迹指标。 */
  evidenceTools?: readonly string[];
}

/** 用指定引擎诊断一个已准备好的用例。 */
export async function runEngine(
  engine: EngineName,
  prepared: PreparedCase,
  config: ServerConfig,
  options: RunOptions = {},
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

  const client =
    options.client ??
    (engine === 'agent-local' ? new LocalScriptedClient(0) : new OpenAICompatibleClient(config));
  const events: InvestigationEvent[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, steps: 0, toolCalls: 0 };
  const startedAt = performance.now();
  let report;
  try {
    report = await investigate({
      client,
      context: {
        database: prepared.database,
        issueId: prepared.issueId,
        projectId: 'demo-project',
        allowSourceContext: config.agentSourceContext,
        // 评测用例没有 git 仓库：代码类工具如实回答「没有配置仓库」，而不是读到演示仓库里无关的代码。
        repositoryRoot: null,
      },
      issue: { id: prepared.issueId, title: prepared.issueTitle },
      emit: (event) => events.push(event),
      signal: AbortSignal.timeout(180_000),
      usage,
    });
  } catch (error) {
    const trajectory = summarizeTrajectory(events, options.evidenceTools);
    const code =
      error instanceof InvestigationError
        ? error.code
        : error instanceof ReplayError
          ? 'REPLAY_DIVERGED'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'TIMEOUT'
            : 'MODEL_ERROR';
    throw new EngineRunError(
      code,
      error instanceof Error ? error.message : String(error),
      trajectory,
    );
  }
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
    trajectory: summarizeTrajectory(events, options.evidenceTools),
  };
}
