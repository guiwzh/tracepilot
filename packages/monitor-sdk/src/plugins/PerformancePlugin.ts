import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';
import type { MonitorPlugin, PluginContext } from '../types';

/**
 * 指标的计算交给 Google 官方的 web-vitals 库，本插件只决定「什么时候、以什么形式」上报。
 *
 * 早期版本自己用 PerformanceObserver 计算，三个口径都是错的：CLS 把所有偏移直接累加
 * （现行定义是按会话窗口取最大值），INP 取了所有 event 条目的最大时长（应只看带
 * interactionId 的交互、按交互分组后取高分位），LCP 在用户首次输入后仍在更新。
 * 这些规则还在演进（2024 年 INP 取代了 FID），跟着官方库走比自己维护可靠。
 *
 * web-vitals 的 onXXX 没有注销 API，注册的 PerformanceObserver 和监听器会存活到页面结束。
 * 如果每次 setup 都注册一遍，SPA 里反复 start/destroy 会让它们无限累积。
 * 所以整页只注册一次（模块级单例），插件实例只是这个分发中心的订阅者。
 */
type Subscriber = (metric: Metric) => void;

const subscribers = new Set<Subscriber>();
const latest = new Map<Metric['name'], Metric>();
let registered = false;

function registerOnce(): void {
  if (registered) return;
  registered = true;
  const forward = (metric: Metric) => {
    latest.set(metric.name, metric);
    for (const subscriber of subscribers) subscriber(metric);
  };
  // reportAllChanges：每次数值变化都回调。插件因此总能拿到最新值，
  // 即使 destroy() 发生在页面隐藏之前（SPA 卸载、热更新），也能提交当时的值。
  onLCP(forward, { reportAllChanges: true });
  onCLS(forward, { reportAllChanges: true });
  onINP(forward, { reportAllChanges: true });
  onFCP(forward);
  onTTFB(forward);
}

// FCP 和 TTFB 一经产生就不再变化，到达即上报；另外三个在页面生命周期里持续变化，
// 只在页面隐藏（核心调用 onPageHidden）或插件销毁时提交最新值。
const FINAL_ON_ARRIVAL = new Set<Metric['name']>(['FCP', 'TTFB']);

export class PerformancePlugin implements MonitorPlugin {
  readonly name = 'PerformancePlugin';
  private context?: PluginContext;
  // 每个指标实例（metric.id）已经上报过的值。值变化后会以同一个 id 再报一次，服务端按 id 覆盖。
  private readonly reported = new Map<string, number>();
  private readonly pending = new Map<Metric['name'], Metric>();
  private readonly onMetric = (metric: Metric) => {
    if (FINAL_ON_ARRIVAL.has(metric.name)) this.report(metric);
    else this.pending.set(metric.name, metric);
  };

  setup(context: PluginContext): void {
    if (this.context || typeof window === 'undefined') return;
    this.context = context;
    subscribers.add(this.onMetric);
    registerOnce();
    // 晚于首批指标创建的实例（例如 StrictMode 下的第二次挂载）补收已有的值。
    // 放进微任务是因为 setup 期间核心会屏蔽采集；重复的值与之前同 id，服务端覆盖而不是重复计数。
    queueMicrotask(() => {
      if (!this.context) return;
      for (const metric of latest.values()) this.onMetric(metric);
    });
  }

  private report(metric: Metric): void {
    if (this.reported.get(metric.id) === metric.value) return;
    const eventId = this.context?.captureEvent('performance', {
      metric: metric.name,
      value: Number(metric.value.toFixed(metric.name === 'CLS' ? 4 : 1)),
      rating: metric.rating,
      metricId: metric.id,
      navigationType: metric.navigationType,
    });
    // 只在真正进入采集链路后才记为已上报；被闸门或 beforeSend 拦下的值下次还有机会。
    if (eventId) this.reported.set(metric.id, metric.value);
  }

  /**
   * 页面进入后台或即将卸载：提交 LCP/CLS/INP 的最新值。由核心在传输层的退出发送之前调用；
   * 插件自己监听 pagehide 的话，监听器可能排在传输层之后，提交的值就赶不上这次发送。
   */
  onPageHidden(): void {
    for (const metric of this.pending.values()) this.report(metric);
    this.pending.clear();
  }

  teardown(): void {
    this.onPageHidden();
    subscribers.delete(this.onMetric);
    this.reported.clear();
    this.context = undefined;
  }
}
