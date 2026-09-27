import {
  MAX_BREADCRUMBS,
  redactSensitive,
  type Breadcrumb,
  type MonitorEvent,
} from '@trace-pilot/shared';
import type {
  BreadcrumbInput,
  CapturePayload,
  DeliveryStats,
  MonitorClient,
  MonitorOptions,
  MonitorPlugin,
  MonitorUser,
  PluginContext,
  ResolvedMonitorOptions,
} from '../types';
import { Transport } from '../transport/Transport';
import {
  breadcrumbId,
  createId,
  errorPayload,
  getDeviceContext,
  getPageContext,
  sessionSampled,
} from './helpers';
import { dedupeSignature, isIgnoredError } from './noise';
import { resolveOptions } from './options';
import { redactPayload } from './privacy';

export class MonitorCore implements MonitorClient {
  readonly options: Readonly<ResolvedMonitorOptions>;
  // 传输层由核心直接持有并管理生命周期，不再是一个必须最后注册的插件：
  // 那种设计的正确性依赖注册顺序，而公开的 use() 随时可以打破它。
  private readonly transport: Transport;
  private readonly plugins: MonitorPlugin[] = [];
  /** 交给插件的窄接口：只有采集入口和只读配置。 */
  private readonly context: PluginContext;
  private readonly breadcrumbs: Breadcrumb[] = [];
  private readonly recentSignals = new Map<string, number>();
  private started = false;
  private destroyed = false;
  // 插件是否已经安装。未采样的会话从不安装，销毁时也就不必 teardown。
  private installed = false;
  // 本会话是否被采样。未被采样时插件根本不安装，宿主页面不承担任何包装和监听的开销。
  private readonly sampled: boolean;
  private user?: MonitorUser;
  // protect() 的重入标志：只负责“同一时刻不嵌套执行插件生命周期代码”。
  private protecting = false;
  // 生命周期期间是否屏蔽采集。插件 setup 会包装全局 API，这个过程自身产生的信号属于
  // SDK 的副作用而不是业务事件，因此要丢弃；teardown 则相反——提交最终指标正是它的职责，
  // 所以 destroy 不设这个标志。两者曾共用 protecting 一个变量，导致最终 Web Vitals 被静默丢弃。
  private suppressCapture = false;
  // 采集路径自身的重入标志，防止 beforeSend 或插件回调在采集过程中再次触发采集。
  private capturing = false;
  // 页面进入后台或卸载时先通知插件提交最后的样本。这两个监听器在 start() 里早于传输层注册，
  // 同一事件上监听器按注册顺序执行，所以插件提交的数据一定赶得上随后的退出发送。
  private readonly onPageHide = () => this.notifyPageHidden();
  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.notifyPageHidden();
    }
  };

  constructor(options: MonitorOptions) {
    this.options = resolveOptions(options);
    this.user = options.user;
    this.sampled = sessionSampled(options.projectId, this.options.sampleRate);
    this.transport = new Transport({
      endpoint: options.dsn,
      dsnKey: options.dsnKey ?? options.projectId,
      batchSize: this.options.batchSize,
      flushInterval: this.options.flushInterval,
      maxRetries: this.options.maxRetries,
      maxQueueSize: this.options.maxQueueSize,
      // undefined 表示使用默认的 localStorage；显式关闭时不做退出持久化。
      storage: options.persistence === false ? null : undefined,
    });
    this.context = {
      options: this.options,
      captureEvent: (eventType, payload) => this.captureEvent(eventType, payload),
      addBreadcrumb: (breadcrumb) => this.addBreadcrumb(breadcrumb),
    };
  }

  use(plugin: MonitorPlugin): this {
    // 同名插件只注册一次；start 之后动态 use 时也能立即挂载。
    if (this.plugins.some((candidate) => candidate.name === plugin.name)) return this;
    this.plugins.push(plugin);
    if (this.installed) this.protect(() => plugin.setup(this.context));
    return this;
  }

  start(): void {
    // start/destroy 都设计为幂等，适配 React StrictMode 中开发期的重复生命周期。
    if (this.started || this.destroyed) return;
    this.started = true;
    if (!this.sampled) return;
    this.installed = true;
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    for (const plugin of this.plugins) this.protect(() => plugin.setup(this.context));
    // 插件全部就绪后才启动传输：定时发送、退出监听和上次遗留事件的补发都从这里开始。
    this.transport.start();
  }

  isStarted(): boolean {
    return this.started;
  }

  setUser(user?: MonitorUser): void {
    this.user = user;
  }

  addBreadcrumb(breadcrumb: BreadcrumbInput): void {
    if (this.destroyed || !this.sampled) return;
    // 面包屑在加入时脱敏一次；之后它会随多个事件一起发送，不必每次重复处理。
    const redacted = redactSensitive({
      ...breadcrumb,
      timestamp: breadcrumb.timestamp ?? Date.now(),
    });
    // Breadcrumb 是一个有界环形历史：超过上限时丢弃最旧项，控制每个事件的体积。
    this.breadcrumbs.push(breadcrumbId(redacted));
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
    if (!this.started || this.destroyed || !this.sampled || this.suppressCapture) return null;
    // 采集不能自我触发：beforeSend 若在回调里再次调用 captureException，
    // 没有这道闸门就会无限递归下去。
    if (this.capturing) return null;
    if (eventType === 'error' && isIgnoredError(payload, this.options.ignoreErrors)) return null;
    // 去重放在创建完整上下文之前，错误风暴中被挡下的事件几乎没有开销。
    if (this.isDuplicate(eventType, payload)) return null;

    this.capturing = true;
    try {
      const event: MonitorEvent = {
        eventId: createId(),
        eventType,
        timestamp: Date.now(),
        projectId: this.options.projectId,
        release: this.options.release,
        environment: this.options.environment,
        page: redactSensitive(getPageContext()),
        user: this.user,
        device: getDeviceContext(),
        payload: redactPayload(payload),
        // 面包屑是 Issue 的证据链，只随会形成 Issue 的事件发送。指标样本不属于任何 Issue，
        // 带上 50 条面包屑只会让每个样本的体积大几十倍。
        breadcrumbs: eventType === 'performance' ? [] : this.getBreadcrumbs(),
      };
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

  private isDuplicate(eventType: MonitorEvent['eventType'], payload: CapturePayload): boolean {
    const signature = dedupeSignature(eventType, payload);
    if (signature === null) return false;
    const now = Date.now();
    const last = this.recentSignals.get(signature);
    this.recentSignals.set(signature, now);
    // 顺便淘汰过期签名，避免长时间打开的页面让 Map 无限增长。
    for (const [key, timestamp] of this.recentSignals) {
      if (now - timestamp > this.options.dedupeWindow * 2) this.recentSignals.delete(key);
    }
    return last !== undefined && now - last < this.options.dedupeWindow;
  }

  /**
   * 隔离插件生命周期代码：插件抛错绝不能波及宿主应用或其他插件。
   *
   * `allowCapture` 区分两种生命周期：
   * - setup（默认 false）：包装全局 API 的过程若顺带产生信号，那是 SDK 自身的副作用，丢弃。
   * - teardown 与页面隐藏（true）：提交最终 LCP/CLS/INP 正是它们要做的事，必须放行。
   *
   * 递归风暴由 captureEvent 自己的 capturing 标志防护，与这里无关。
   */
  private protect(action: () => void, allowCapture = false): void {
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

  private notifyPageHidden(): void {
    for (const plugin of this.plugins) {
      if (plugin.onPageHidden) this.protect(() => plugin.onPageHidden!(), true);
    }
  }

  async flush(): Promise<DeliveryStats> {
    await this.transport.flush();
    return this.transport.stats();
  }

  stats(): DeliveryStats {
    return this.transport.stats();
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.installed) {
      // 逆序 teardown：后装的插件先收尾。teardown 里提交的最终样本（例如 LCP/CLS/INP）必须放行，
      // 而 destroy 在 SPA 组件卸载、热更新和 StrictMode 双次挂载时都会走到。
      for (const plugin of [...this.plugins].reverse()) this.protect(() => plugin.teardown(), true);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
      }
    }
    this.destroyed = true;
    this.started = false;
    this.installed = false;
    // 插件全部收尾之后才销毁传输层：它们刚提交的事件随这次退出发送一起交给浏览器。
    this.transport.destroy();
    this.breadcrumbs.length = 0;
    this.recentSignals.clear();
  }
}
