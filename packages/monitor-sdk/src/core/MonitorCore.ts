import {
  DEFAULT_MAX_QUEUE_SIZE,
  MAX_BREADCRUMBS,
  type Breadcrumb,
  type MonitorEvent,
} from '@trace-pilot/shared';
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
      'sampleRate' | 'batchSize' | 'flushInterval' | 'maxRetries' | 'dedupeWindow' | 'maxQueueSize'
    >
  > &
    MonitorOptions;
  private readonly plugins: MonitorPlugin[] = [];
  private readonly breadcrumbs: Breadcrumb[] = [];
  private readonly recentErrors = new Map<string, number>();
  private started = false;
  private destroyed = false;
  private user?: MonitorUser;
  // protect() 的重入标志：只负责“同一时刻不嵌套执行插件生命周期代码”。
  private protecting = false;
  // 生命周期期间是否屏蔽采集。插件 setup 会包装全局 API，这个过程自身产生的信号属于
  // SDK 的副作用而不是业务事件，因此要丢弃；teardown 则相反——提交最终指标正是它的职责，
  // 所以 destroy 不设这个标志。两者曾共用 protecting 一个变量，导致最终 Web Vitals 被静默丢弃。
  private suppressCapture = false;
  // 采集路径自身的重入标志，防止 beforeSend 或插件回调在采集过程中再次触发采集。
  private capturing = false;

  constructor(options: MonitorOptions) {
    // Required<Pick<...>> 对应的默认值只在这一处生成，后续插件拿到的一定是合法范围。
    this.options = {
      ...options,
      sampleRate: boundedNumber(options.sampleRate, 1, 0, 1),
      batchSize: boundedInteger(options.batchSize, 10, 1, 100),
      flushInterval: boundedInteger(options.flushInterval, 5_000, 100, 86_400_000),
      maxRetries: boundedInteger(options.maxRetries, 2, 0, 10),
      dedupeWindow: boundedInteger(options.dedupeWindow, 5_000, 0, 600_000),
      maxQueueSize: boundedInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 10, 10_000),
    };
    this.user = options.user;
    this.transport = new Transport({
      endpoint: options.dsn,
      dsnKey: options.dsnKey ?? options.projectId,
      batchSize: this.options.batchSize,
      flushInterval: this.options.flushInterval,
      maxRetries: this.options.maxRetries,
      maxQueueSize: this.options.maxQueueSize,
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
    if (!this.started || this.destroyed || this.suppressCapture) return null;
    // 采集不能自我触发：beforeSend 若在回调里再次调用 captureException，
    // 没有这道闸门就会无限递归下去。
    if (this.capturing) return null;
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

    this.capturing = true;
    try {
      // beforeSend 是业务方最后一次删除字段或取消事件的机会。
      const processed = this.options.beforeSend ? this.options.beforeSend(event) : event;
      if (!processed) return null;
      this.transport.enqueue(processed);
      return processed.eventId;
    } catch {
      return null;
    } finally {
      this.capturing = false;
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

  /**
   * 隔离插件生命周期代码：插件抛错绝不能波及宿主应用或其他插件。
   *
   * `allowCapture` 区分两种生命周期：
   * - setup（默认 false）：包装全局 API 的过程若顺带产生信号，那是 SDK 自身的副作用，丢弃。
   * - teardown（true）：提交最终 LCP/CLS/INP 正是它要做的事，必须放行。
   *
   * 递归风暴由 captureEvent 自己的 capturing 标志防护，与这里无关。
   */
  protect(action: () => void, allowCapture = false): void {
    if (this.protecting) return;
    this.protecting = true;
    this.suppressCapture = !allowCapture;
    try {
      action();
    } catch {
      // 插件异常被隔离；其他插件和业务页面继续运行。
    } finally {
      this.protecting = false;
      this.suppressCapture = false;
    }
  }

  async flush(): Promise<void> {
    await this.transport.flush();
  }

  destroy(): void {
    if (this.destroyed) return;
    // Transport 最后注册，因此正序 teardown 会先让信号插件提交最终样本，再由传输层冲刷队列。
    // 这里必须放行采集，否则 PerformancePlugin 的最终 LCP/CLS/INP 会被闸门拦掉——
    // 而 destroy 在 SPA 组件卸载、热更新和 StrictMode 双次挂载时都会走到。
    for (const plugin of this.plugins) this.protect(() => plugin.teardown(), true);
    this.destroyed = true;
    this.started = false;
    this.breadcrumbs.length = 0;
    this.recentErrors.clear();
  }
}
