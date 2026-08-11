import { WEB_VITAL_THRESHOLDS } from '@trace-pilot/shared';
import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

type VitalName = keyof typeof WEB_VITAL_THRESHOLDS;

// 将原始数值映射到 Dashboard 使用的三档评级，阈值由 shared 包统一提供。
function rating(metric: VitalName, value: number): 'good' | 'needs-improvement' | 'poor' {
  const [good, poor] = WEB_VITAL_THRESHOLDS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

export class PerformancePlugin implements MonitorPlugin {
  readonly name = 'PerformancePlugin';
  private core?: MonitorCore;
  private readonly observers: PerformanceObserver[] = [];
  private cls = 0;
  private inp = 0;
  private lcp?: number;
  private hasCls = false;
  private hasInp = false;
  private finalized = false;
  private readonly reported = new Set<VitalName>();
  private readonly onPageHide = () => this.finalize();
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.finalize();
  };

  setup(core: MonitorCore): void {
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    if (typeof PerformanceObserver === 'undefined') return;
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    // buffered: true 会把 observer 创建前已发生的性能条目也补回来。
    this.observe('paint', (entry) => {
      if (entry.name === 'first-contentful-paint') this.reportOnce('FCP', entry.startTime);
    });
    this.observe('largest-contentful-paint', (entry) => {
      this.lcp = entry.startTime;
    });
    this.observe('layout-shift', (entry) => {
      const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      // 用户主动点击导致的布局变化不计入 CLS。
      if (!shift.hadRecentInput) {
        this.cls += shift.value ?? 0;
        this.hasCls = true;
      }
    });
    this.observe('event', (entry) => {
      // INP 关注最慢交互，本地 MVP 取观察期内最大的 event duration。
      this.inp = Math.max(this.inp, entry.duration);
      this.hasInp = true;
    });
    queueMicrotask(() => {
      // Navigation Timing 的 responseStart 近似当前页面的 TTFB。
      const navigation = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
      if (navigation) this.reportOnce('TTFB', navigation.responseStart);
    });
  }

  private observe(type: string, onEntry: (entry: PerformanceEntry) => void): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onEntry(entry);
      });
      observer.observe({ type, buffered: true });
      this.observers.push(observer);
    } catch {
      // 各浏览器支持的 entry type 不同；单个指标不可用不应影响其他采集。
    }
  }

  private reportOnce(metric: VitalName, value: number): void {
    if (this.reported.has(metric)) return;
    this.reported.add(metric);
    this.core?.captureEvent('performance', {
      metric,
      value: Number(value.toFixed(metric === 'CLS' ? 4 : 1)),
      rating: rating(metric, value),
    });
  }

  private finalize(): void {
    // LCP/CLS/INP 在页面生命周期中会变化，页面隐藏时才提交最终值。
    if (this.finalized) return;
    this.finalized = true;
    if (this.lcp !== undefined) this.reportOnce('LCP', this.lcp);
    if (this.hasCls) this.reportOnce('CLS', this.cls);
    if (this.hasInp) this.reportOnce('INP', this.inp);
  }

  teardown(): void {
    this.finalize();
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.core = undefined;
  }
}
