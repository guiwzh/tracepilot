import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metric } from 'web-vitals';
import type { MonitorEvent } from '@trace-pilot/shared';
import type { PluginContext } from '../../src/types';

/**
 * web-vitals 被替换成可手动触发的假实现：指标算法由官方库负责并有它自己的测试，
 * 这里只验证本插件的上报时机、去重与单例注册。
 */
const webVitals = vi.hoisted(() => ({
  callbacks: new Map<string, (metric: unknown) => void>(),
  registrations: 0,
}));

vi.mock('web-vitals', () => {
  const register = (name: string) => (callback: (metric: unknown) => void) => {
    webVitals.registrations += 1;
    webVitals.callbacks.set(name, callback);
  };
  return {
    onLCP: register('LCP'),
    onCLS: register('CLS'),
    onINP: register('INP'),
    onFCP: register('FCP'),
    onTTFB: register('TTFB'),
  };
});

function emit(name: Metric['name'], value: number, id = `v6-${name}-1`): void {
  webVitals.callbacks.get(name)?.({
    name,
    value,
    rating: 'good',
    delta: value,
    id,
    entries: [],
    navigationType: 'navigate',
    navigationId: 1,
  } satisfies Metric);
}

// 插件的单例状态是模块级的，每个用例重新加载模块，互不影响。
async function freshPlugin() {
  const { PerformancePlugin } = await import('../../src/plugins/PerformancePlugin');
  return new PerformancePlugin();
}

function fakeContext() {
  const captureEvent = vi.fn((_type: string, _payload: Record<string, unknown>) => 'event-id');
  return { captureEvent, context: { captureEvent } as unknown as PluginContext };
}

beforeEach(() => {
  vi.resetModules();
  webVitals.callbacks.clear();
  webVitals.registrations = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PerformancePlugin', () => {
  it('reports FCP on arrival and the latest LCP, CLS and INP only when the page is hidden', async () => {
    const plugin = await freshPlugin();
    const { captureEvent, context } = fakeContext();
    plugin.setup(context);

    emit('FCP', 900);
    expect(captureEvent).toHaveBeenCalledTimes(1);

    emit('LCP', 1_200);
    emit('LCP', 2_200);
    emit('CLS', 0.05);
    emit('CLS', 0.15);
    emit('INP', 80);
    emit('INP', 180);
    expect(captureEvent).toHaveBeenCalledTimes(1);

    // 页面隐藏由核心通过 onPageHidden 通知；同一值重复通知不会重复上报。
    plugin.onPageHidden();
    plugin.onPageHidden();

    expect(captureEvent.mock.calls.map(([, payload]) => [payload.metric, payload.value])).toEqual([
      ['FCP', 900],
      ['LCP', 2_200],
      ['CLS', 0.15],
      ['INP', 180],
    ]);
    expect(captureEvent.mock.calls[1]![1]).toMatchObject({ metricId: 'v6-LCP-1' });
    plugin.teardown();
  });

  it('reports a grown value again under the same metric id so the server can overwrite it', async () => {
    const plugin = await freshPlugin();
    const { captureEvent, context } = fakeContext();
    plugin.setup(context);

    emit('CLS', 0.15);
    plugin.onPageHidden();
    // 用户切回标签页后又发生了布局偏移。
    emit('CLS', 0.3);
    plugin.onPageHidden();

    expect(captureEvent.mock.calls.map(([, payload]) => [payload.metricId, payload.value])).toEqual(
      [
        ['v6-CLS-1', 0.15],
        ['v6-CLS-1', 0.3],
      ],
    );
    plugin.teardown();
  });

  it('registers web-vitals once per page however many times monitors start and stop', async () => {
    const { PerformancePlugin } = await import('../../src/plugins/PerformancePlugin');
    const first = fakeContext();
    for (let round = 0; round < 3; round += 1) {
      const plugin = new PerformancePlugin();
      plugin.setup(round === 0 ? first.context : fakeContext().context);
      plugin.teardown();
    }
    // 5 个指标各注册一次，而不是 15 次——库没有注销 API，重复注册会一直累积。
    expect(webVitals.registrations).toBe(5);

    emit('FCP', 700);
    // 已销毁的实例不再收到指标。
    expect(first.captureEvent).not.toHaveBeenCalled();
  });

  it('replays metrics that arrived before a later instance started', async () => {
    const { PerformancePlugin } = await import('../../src/plugins/PerformancePlugin');
    const early = new PerformancePlugin();
    early.setup(fakeContext().context);
    emit('TTFB', 320);
    early.teardown();

    const late = new PerformancePlugin();
    const { captureEvent, context } = fakeContext();
    late.setup(context);
    await Promise.resolve();

    expect(captureEvent).toHaveBeenCalledWith(
      'performance',
      expect.objectContaining({ metric: 'TTFB', value: 320, metricId: 'v6-TTFB-1' }),
    );
    late.teardown();
  });

  /**
   * 上面几条用假核心隔离验证上报规则，但正因为绕开了 MonitorCore，它们发现不了真实链路上的问题：
   * 核心的生命周期闸门曾把 teardown 里的提交一并拦掉，destroy() 于是静默丢弃全部最终指标。
   * 这两条测试接真实核心，堵住那个盲区。
   */
  it('delivers pending metrics with the exit flush when the real core is destroyed', async () => {
    const { MonitorCore } = await import('../../src/core/MonitorCore');
    const { PerformancePlugin } = await import('../../src/plugins/PerformancePlugin');
    const monitor = new MonitorCore({
      dsn: 'http://localhost/envelopes',
      dsnKey: 'test-key',
      projectId: 'test-project',
      release: '1.0.0',
      environment: 'test',
      batchSize: 100,
      persistence: false,
    });
    monitor.use(new PerformancePlugin());
    monitor.start();

    emit('LCP', 2_200);
    // 页面还活着，LCP 仍可能变化，尚未提交。
    expect(monitor.stats().pending).toBe(0);

    monitor.destroy();
    expect(await beaconMetrics()).toEqual([['LCP', 2_200]]);
  });

  it('submits the latest values before the exit flush when the page is hidden', async () => {
    const { MonitorCore } = await import('../../src/core/MonitorCore');
    const { PerformancePlugin } = await import('../../src/plugins/PerformancePlugin');
    const monitor = new MonitorCore({
      dsn: 'http://localhost/envelopes',
      dsnKey: 'test-key',
      projectId: 'test-project',
      release: '1.0.0',
      environment: 'test',
      batchSize: 100,
      persistence: false,
    });
    monitor.use(new PerformancePlugin());
    monitor.start();

    emit('INP', 180);
    window.dispatchEvent(new Event('pagehide'));
    // 核心先通知插件提交，再由传输层发出退出 beacon：INP 就在这一个 beacon 里。
    expect(await beaconMetrics()).toEqual([['INP', 180]]);
    monitor.destroy();
  });
});

async function beaconMetrics(): Promise<Array<[unknown, unknown]>> {
  const calls = vi.mocked(navigator.sendBeacon).mock.calls;
  const bodies = await Promise.all(calls.map(([, body]) => (body as Blob).text()));
  return bodies
    .flatMap((body) => (JSON.parse(body) as { events: MonitorEvent[] }).events)
    .map((event) => [event.payload.metric, event.payload.value]);
}
