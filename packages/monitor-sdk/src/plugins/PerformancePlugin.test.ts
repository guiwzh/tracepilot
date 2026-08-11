import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorCore } from '../core/MonitorCore';
import { PerformancePlugin } from './PerformancePlugin';

// FakePerformanceObserver 主动发出浏览器性能条目，精确验证最终上报时机和计算规则。
type EmitEntries = (entries: PerformanceEntry[]) => void;

const emitters = new Map<string, EmitEntries>();

class FakePerformanceObserver {
  constructor(private readonly callback: PerformanceObserverCallback) {}

  observe(options: PerformanceObserverInit): void {
    if (!options.type) return;
    emitters.set(options.type, (entries) => {
      this.callback(
        { getEntries: () => entries } as PerformanceObserverEntryList,
        this as unknown as PerformanceObserver,
      );
    });
  }

  disconnect(): void {}
}

function entry(name: string, startTime: number, duration = 0): PerformanceEntry {
  return { name, entryType: name, startTime, duration, toJSON: () => ({}) };
}

afterEach(() => {
  emitters.clear();
  vi.unstubAllGlobals();
});

describe('PerformancePlugin', () => {
  it('reports one final LCP, CLS, and INP sample when the page is hidden', async () => {
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    const captureEvent = vi.fn();
    const plugin = new PerformancePlugin();
    plugin.setup({ captureEvent } as unknown as MonitorCore);
    await Promise.resolve();

    emitters.get('largest-contentful-paint')?.([
      entry('largest-contentful-paint', 1_200),
      entry('largest-contentful-paint', 2_200),
    ]);
    emitters.get('layout-shift')?.([
      { ...entry('layout-shift', 100), value: 0.05, hadRecentInput: false } as PerformanceEntry,
      { ...entry('layout-shift', 200), value: 0.1, hadRecentInput: false } as PerformanceEntry,
      { ...entry('layout-shift', 300), value: 0.9, hadRecentInput: true } as PerformanceEntry,
    ]);
    emitters.get('event')?.([entry('event', 400, 80), entry('event', 500, 180)]);

    expect(captureEvent).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));

    expect(captureEvent.mock.calls).toEqual([
      ['performance', { metric: 'LCP', value: 2_200, rating: 'good' }],
      ['performance', { metric: 'CLS', value: 0.15, rating: 'needs-improvement' }],
      ['performance', { metric: 'INP', value: 180, rating: 'good' }],
    ]);
    plugin.teardown();
  });
});
