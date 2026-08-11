import { WEB_VITAL_THRESHOLDS } from '@trace-pilot/shared';
import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

type VitalName = keyof typeof WEB_VITAL_THRESHOLDS;

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

  setup(core: MonitorCore): void {
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    if (typeof PerformanceObserver === 'undefined') return;
    this.observe('paint', (entry) => {
      if (entry.name === 'first-contentful-paint') this.report('FCP', entry.startTime);
    });
    this.observe('largest-contentful-paint', (entry) => this.report('LCP', entry.startTime));
    this.observe('layout-shift', (entry) => {
      const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!shift.hadRecentInput) {
        this.cls += shift.value ?? 0;
        this.report('CLS', this.cls);
      }
    });
    this.observe('event', (entry) => {
      this.inp = Math.max(this.inp, entry.duration);
      this.report('INP', this.inp);
    });
    queueMicrotask(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navigation) this.report('TTFB', navigation.responseStart);
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
      // Unsupported entry types are expected across browser versions.
    }
  }

  private report(metric: VitalName, value: number): void {
    this.core?.captureEvent('performance', {
      metric,
      value: Number(value.toFixed(metric === 'CLS' ? 4 : 1)),
      rating: rating(metric, value),
    });
  }

  teardown(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
    this.core = undefined;
  }
}
