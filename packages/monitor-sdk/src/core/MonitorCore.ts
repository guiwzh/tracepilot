import { MAX_BREADCRUMBS, type Breadcrumb, type MonitorEvent } from '@trace-pilot/shared';
import type {
  CapturePayload,
  MonitorClient,
  MonitorOptions,
  MonitorPlugin,
  MonitorUser,
} from '../types';
import { Transport } from '../transport/Transport';
import { breadcrumbId, createId, errorPayload, getDeviceContext, getPageContext } from './helpers';

// 所有外部数字配置都在边界处夹紧，避免 0 批量、无限重试等配置让 SDK 失控。
function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return Math.floor(boundedNumber(value, fallback, minimum, maximum));
}

export class MonitorCore implements MonitorClient {
  readonly transport: Transport;
  readonly options: Required<
    Pick<
      MonitorOptions,
      'sampleRate' | 'batchSize' | 'flushInterval' | 'maxRetries' | 'dedupeWindow'
    >
  > &
    MonitorOptions;
  private readonly plugins: MonitorPlugin[] = [];
  private readonly breadcrumbs: Breadcrumb[] = [];
  private readonly recentErrors = new Map<string, number>();
  private started = false;
  private destroyed = false;
  private user?: MonitorUser;
  private protecting = false;

  constructor(options: MonitorOptions) {
    // Required<Pick<...>> 对应的默认值只在这一处生成，后续插件拿到的一定是合法范围。
    this.options = {
      ...options,
      sampleRate: boundedNumber(options.sampleRate, 1, 0, 1),
      batchSize: boundedInteger(options.batchSize, 10, 1, 100),
      flushInterval: boundedInteger(options.flushInterval, 5_000, 100, 86_400_000),
      maxRetries: boundedInteger(options.maxRetries, 2, 0, 10),
      dedupeWindow: boundedInteger(options.dedupeWindow, 5_000, 0, 600_000),
    };
    this.user = options.user;
    this.transport = new Transport({
      endpoint: options.dsn,
      dsnKey: options.dsnKey ?? options.projectId,
      batchSize: this.options.batchSize,
      flushInterval: this.options.flushInterval,
      maxRetries: this.options.maxRetries,
    });
  }

  use(plugin: MonitorPlugin): this {
    // 同名插件只注册一次；start 之后动态 use 时也能立即挂载。
    if (this.plugins.some((candidate) => candidate.name === plugin.name)) return this;
    this.plugins.push(plugin);
    if (this.started) this.protect(() => plugin.setup(this));
    return this;
  }

  start(): void {
    // start/destroy 都设计为幂等，适配 React StrictMode 中开发期的重复生命周期。
    if (this.started || this.destroyed) return;
    this.started = true;
    for (const plugin of this.plugins) this.protect(() => plugin.setup(this));
  }

  isStarted(): boolean {
    return this.started;
  }

  setUser(user?: MonitorUser): void {
    this.user = user;
  }

  addBreadcrumb(
    breadcrumb: Omit<Breadcrumb, 'id' | 'timestamp'> & Partial<Pick<Breadcrumb, 'timestamp'>>,
  ): void {
    if (this.destroyed) return;
    // Breadcrumb 是一个有界环形历史：超过上限时丢弃最旧项，控制每个事件的体积。
    this.breadcrumbs.push(
      breadcrumbId({ ...breadcrumb, timestamp: breadcrumb.timestamp ?? Date.now() }),
    );
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.shift();
  }

  getBreadcrumbs(): Breadcrumb[] {
    // 返回浅拷贝，避免调用方修改 SDK 内部正在积累的数组。
    return this.breadcrumbs.map((item) => ({ ...item }));
  }

  captureException(error: unknown, context: CapturePayload = {}): string | null {
    return this.captureEvent('error', { ...errorPayload(error), ...context, level: 'error' });
  }

  captureMessage(message: string, level: 'error' | 'warning' | 'info' = 'info'): string | null {
    return this.captureEvent('error', { name: 'Message', message, level });
  }

  captureEvent(eventType: MonitorEvent['eventType'], payload: CapturePayload): string | null {
    if (!this.started || this.destroyed || this.protecting) return null;
    // 先采样、再去重，尽量在创建完整上下文前快速退出。
    if (Math.random() > this.options.sampleRate) return null;
    if (eventType === 'error' && this.isDuplicate(payload)) return null;

    const event: MonitorEvent = {
      eventId: createId(),
      eventType,
      timestamp: Date.now(),
      projectId: this.options.projectId,
      release: this.options.release,
      environment: this.options.environment,
      page: getPageContext(),
      user: this.user,
      device: getDeviceContext(),
      payload,
      breadcrumbs: this.getBreadcrumbs(),
    };

    try {
      // beforeSend 是业务方最后一次删除字段或取消事件的机会。
      const processed = this.options.beforeSend ? this.options.beforeSend(event) : event;
      if (!processed) return null;
      this.transport.enqueue(processed);
      return processed.eventId;
    } catch {
      return null;
    }
  }

  private isDuplicate(payload: CapturePayload): boolean {
    // 行列号常随构建变化；签名只保留错误类型、消息和归一化后的首个调用帧。
    const frame = (String(payload.stack ?? '').split('\n')[1] ?? '').replace(
      /:\d+:\d+(?=\)?$)/,
      ':line:column',
    );
    const signature = `${String(payload.name ?? '')}|${String(payload.message ?? '')}|${frame}`;
    const now = Date.now();
    const last = this.recentErrors.get(signature);
    this.recentErrors.set(signature, now);
    // 顺便淘汰过期签名，避免长时间打开的页面让 Map 无限增长。
    for (const [key, timestamp] of this.recentErrors) {
      if (now - timestamp > this.options.dedupeWindow * 2) this.recentErrors.delete(key);
    }
    return last !== undefined && now - last < this.options.dedupeWindow;
  }

  protect(action: () => void): void {
    // 监控代码绝不能破坏宿主应用，也不能把自身异常再次采集形成递归风暴。
    if (this.protecting) return;
    this.protecting = true;
    try {
      action();
    } catch {
      // 插件异常被隔离；其他插件和业务页面继续运行。
    } finally {
      this.protecting = false;
    }
  }

  async flush(): Promise<void> {
    await this.transport.flush();
  }

  destroy(): void {
    if (this.destroyed) return;
    // Transport 最后注册，因此正序 teardown 会先让信号插件提交最终样本，再由传输层冲刷队列。
    for (const plugin of this.plugins) this.protect(() => plugin.teardown());
    this.destroyed = true;
    this.started = false;
    this.breadcrumbs.length = 0;
    this.recentErrors.clear();
  }
}
