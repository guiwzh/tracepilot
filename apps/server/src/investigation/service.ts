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
 *
 * 「在后台执行」：start() 启动 execute() 后不 await 它就直接返回，HTTP 请求立刻得到响应（新建时 201，
 * 已有进行中的调查时 200）；调查在同一个 Node 进程里继续异步推进（等模型响应时不占用 CPU，
 * 不影响处理其他请求）。
 *
 * 取消用的是 AbortController，和前端取消 fetch 是同一个 API：controller.abort(reason) 之后，
 * 所有拿着 controller.signal 的地方（模型请求、Agent 循环）都会收到取消。
 */

/** 每次调查新建一个模型客户端的工厂函数；测试通过它注入替身。 */
export type ModelClientFactory = () => ModelClient;

/** 配置了密钥就用真实模型，否则用离线脚本。 */
export function defaultModelClientFactory(config: ServerConfig): ModelClientFactory {
  return () =>
    config.modelApiKey && config.modelApiUrl
      ? new OpenAICompatibleClient(config)
      : new LocalScriptedClient(config.localAgentStepDelayMs);
}

/** 同时进行的调查上限：每次调查都会产生多次计费的模型调用，必须有全局闸门。 */
const MAX_CONCURRENT_RUNS = 3;
/** 单次调查的总时限（3 分钟），到点自动中止并记为 TIMEOUT。 */
const RUN_TIMEOUT_MS = 180_000;

/** start() 的结果，路由据此返回 201 / 200 / 404 / 429。 */
export type StartResult =
  | { status: 'created' | 'existing'; run: InvestigationRun }
  | { status: 'issue_not_found' }
  | { status: 'busy' };

/** 一个正在进行的调查：用 controller 取消它，用 done 等它彻底结束。 */
interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

export class InvestigationService {
  /** 本进程里正在跑的调查（runId → ActiveRun）。只在内存里，进程重启即清空。 */
  private readonly active = new Map<string, ActiveRun>();
  /** 运行结束（完成、失败、取消）后的回调：告警据此给自动调查发跟进通知。 */
  private readonly finishedListeners = new Set<(run: InvestigationRun) => void>();

  constructor(
    private readonly database: TraceDatabase,
    private readonly config: ServerConfig,
    private readonly store: InvestigationStore,
    private readonly createClient: ModelClientFactory,
    private readonly limits: Partial<InvestigationLimits> = {},
  ) {}

  /** 订阅运行结束；返回取消订阅的函数。回调里的异常只影响它自己，不影响运行的收尾。 */
  onFinished(listener: (run: InvestigationRun) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  /**
   * 为一个 Issue 发起调查（同步返回，调查本身在后台进行）。startedBy 记下是人点的还是告警发起的，
   * 告警发起的有每日上限（services/autoInvestigation.ts）。
   */
  start(issueId: string, startedBy: InvestigationRun['startedBy'] = 'person'): StartResult {
    const issue = this.database.sqlite
      .prepare('SELECT id, project_id, title FROM issues WHERE id = ?')
      .get(issueId) as { id: string; project_id: string; title: string } | undefined;
    if (!issue) return { status: 'issue_not_found' };

    // 同一个 Issue 只允许一个进行中的调查：重复点击或多个标签页会接到同一次运行上。
    const running = this.store.runningRunFor(issueId);
    if (running && this.active.has(running.id)) return { status: 'existing', run: running };
    if (this.active.size >= MAX_CONCURRENT_RUNS) return { status: 'busy' };

    const client = this.createClient();
    const run = this.store.createRun(issueId, client.engine, client.model, startedBy);
    this.store.append(run.id, { type: 'run.started', engine: client.engine, model: client.model });

    const controller = new AbortController();
    // abort 的参数会成为 signal.reason，execute 结束时据此判断是超时、用户取消还是服务关闭。
    const timer = setTimeout(() => controller.abort('timeout'), RUN_TIMEOUT_MS);
    // 注意这里没有 await：execute 在后台运行，finally 在它结束（无论成败）后清理。
    const done = this.execute(run.id, issue, client, controller.signal).finally(() => {
      clearTimeout(timer);
      this.active.delete(run.id);
      this.notifyFinished(run.id);
    });
    this.active.set(run.id, { controller, done });
    return { status: 'created', run };
  }

  private notifyFinished(runId: string): void {
    if (this.finishedListeners.size === 0) return;
    // 服务正在关闭、数据库已经关上时，读不到运行记录，跳过。
    const run = this.database.sqlite.open ? this.store.getRun(runId) : null;
    if (!run) return;
    for (const listener of this.finishedListeners) {
      try {
        listener(run);
      } catch {
        // 订阅方自己的问题（例如告警跟进写库失败）不该让调查的收尾出错。
      }
    }
  }

  /** 取消一个进行中的调查。只是发出取消信号，终止事件由 execute 在收尾时写入。 */
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
    // allSettled：等所有调查都结束，不管各自成功还是失败（Promise.all 遇到第一个失败就会提前返回）。
    await Promise.allSettled(pending.map((run) => run.done));
  }

  /** 跑 Agent 循环，并把任何结局（完成、取消、超时、失败）都落成一个终止事件。 */
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
          repositoryRoot: this.config.repositoryRoot,
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
      // 把各种失败归类成错误码，写进运行记录并推送给界面。错误详情不外露，只给固定描述。
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
