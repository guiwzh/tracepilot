import type { InvestigationRun, InvestigationUsage } from '@trace-pilot/shared';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { investigate, InvestigationError, type InvestigationLimits } from './agent';
import { LocalScriptedClient } from './localClient';
import { ModelCallError, OpenAICompatibleClient, type ModelClient } from './model';
import type { InvestigationStore } from './store';

/**
 * 调查的生命周期编排：创建运行、在后台执行循环、超时、取消、进程关闭时收尾。
 *
 * 运行与 HTTP 连接解耦——关掉页面不等于取消，调查继续在服务端完成，重新打开页面时
 * 通过事件流回放接上。只有显式的取消请求才会中止它。
 */
export type ModelClientFactory = () => ModelClient;

export function defaultModelClientFactory(config: ServerConfig): ModelClientFactory {
  return () =>
    config.modelApiKey && config.modelApiUrl
      ? new OpenAICompatibleClient(config)
      : new LocalScriptedClient(config.localAgentStepDelayMs);
}

/** 同时进行的调查上限：每次调查都会产生多次计费的模型调用，必须有全局闸门。 */
const MAX_CONCURRENT_RUNS = 3;
const RUN_TIMEOUT_MS = 180_000;

export type StartResult =
  | { status: 'created' | 'existing'; run: InvestigationRun }
  | { status: 'issue_not_found' }
  | { status: 'busy' };

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

export class InvestigationService {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly database: TraceDatabase,
    private readonly config: ServerConfig,
    private readonly store: InvestigationStore,
    private readonly createClient: ModelClientFactory,
    private readonly limits: Partial<InvestigationLimits> = {},
  ) {}

  start(issueId: string): StartResult {
    const issue = this.database.sqlite
      .prepare('SELECT id, project_id, title FROM issues WHERE id = ?')
      .get(issueId) as { id: string; project_id: string; title: string } | undefined;
    if (!issue) return { status: 'issue_not_found' };

    // 同一个 Issue 只允许一个进行中的调查：重复点击或多个标签页会接到同一次运行上。
    const running = this.store.runningRunFor(issueId);
    if (running && this.active.has(running.id)) return { status: 'existing', run: running };
    if (this.active.size >= MAX_CONCURRENT_RUNS) return { status: 'busy' };

    const client = this.createClient();
    const run = this.store.createRun(issueId, client.engine, client.model);
    this.store.append(run.id, { type: 'run.started', engine: client.engine, model: client.model });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), RUN_TIMEOUT_MS);
    const done = this.execute(run.id, issue, client, controller.signal).finally(() => {
      clearTimeout(timer);
      this.active.delete(run.id);
    });
    this.active.set(run.id, { controller, done });
    return { status: 'created', run };
  }

  cancel(runId: string): 'cancelled' | 'not_running' | 'not_found' {
    if (!this.store.getRun(runId)) return 'not_found';
    const active = this.active.get(runId);
    if (!active) return 'not_running';
    active.controller.abort('cancelled');
    return 'cancelled';
  }

  /** 进程关闭前中止全部调查并等它们写完终止事件，再由调用方关闭数据库。 */
  async shutdown(): Promise<void> {
    const pending = [...this.active.values()];
    for (const run of pending) run.controller.abort('shutdown');
    await Promise.allSettled(pending.map((run) => run.done));
  }

  private async execute(
    runId: string,
    issue: { id: string; project_id: string; title: string },
    client: ModelClient,
    signal: AbortSignal,
  ): Promise<void> {
    const usage: InvestigationUsage = { inputTokens: 0, outputTokens: 0, steps: 0, toolCalls: 0 };
    try {
      const report = await investigate({
        client,
        context: {
          database: this.database,
          issueId: issue.id,
          projectId: issue.project_id,
          allowSourceContext: this.config.agentSourceContext,
        },
        issue,
        emit: (event) => this.store.append(runId, event),
        signal,
        usage,
        limits: this.limits,
      });
      this.store.finish(runId, 'completed', { type: 'run.completed', report, usage });
    } catch (error) {
      if (signal.aborted && signal.reason === 'cancelled') {
        this.store.finish(runId, 'cancelled', { type: 'run.cancelled', usage });
        return;
      }
      const [code, message] = signal.aborted
        ? signal.reason === 'timeout'
          ? ['TIMEOUT', 'The investigation exceeded its time limit.']
          : ['SERVER_SHUTDOWN', 'The server stopped before the investigation finished.']
        : error instanceof InvestigationError
          ? [error.code, error.message]
          : error instanceof ModelCallError
            ? [
                'MODEL_ERROR',
                `The model request failed${error.status ? ` with HTTP ${error.status}` : ''}.`,
              ]
            : ['INVESTIGATION_FAILED', 'The investigation failed unexpectedly.'];
      this.store.finish(runId, 'failed', { type: 'run.failed', error: code, message, usage });
    }
  }
}
