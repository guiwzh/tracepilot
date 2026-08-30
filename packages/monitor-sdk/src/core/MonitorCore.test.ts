import { describe, expect, it, vi } from 'vitest';
import type { MonitorPlugin } from '../types';
import { MonitorCore } from './MonitorCore';

// 直接实例化核心，隔离验证插件幂等、短窗口去重和 beforeSend 边界。
function core(overrides: Partial<ConstructorParameters<typeof MonitorCore>[0]> = {}) {
  return new MonitorCore({
    dsn: 'http://localhost/envelopes',
    dsnKey: 'test-key',
    projectId: 'test-project',
    release: '1.0.0',
    environment: 'test',
    batchSize: 100,
    ...overrides,
  });
}

describe('MonitorCore', () => {
  it('registers a plugin once and tears it down', () => {
    const setup = vi.fn();
    const teardown = vi.fn();
    const plugin: MonitorPlugin = { name: 'test', setup, teardown };
    const monitor = core().use(plugin).use(plugin);
    monitor.start();
    monitor.start();
    expect(setup).toHaveBeenCalledTimes(1);
    monitor.destroy();
    monitor.destroy();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('deduplicates equal errors inside the configured window', () => {
    const monitor = core({ dedupeWindow: 10_000 });
    monitor.start();
    const first = monitor.captureException(new Error('same failure'));
    const second = monitor.captureException(new Error('same failure'));
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(monitor.transport.pending()).toBe(1);
    monitor.destroy();
  });

  it('supports cancellation and sanitization through beforeSend', () => {
    const monitor = core({
      beforeSend: (event) =>
        event.payload.message === 'drop' ? null : { ...event, payload: { message: '[filtered]' } },
    });
    monitor.start();
    expect(monitor.captureMessage('drop')).toBeNull();
    expect(monitor.captureMessage('keep')).toBeTruthy();
    monitor.destroy();
  });

  it('lets a plugin submit its final sample while tearing down', () => {
    // PerformancePlugin 的最终 LCP/CLS/INP 是在 teardown 里提交的。生命周期闸门
    // 曾经把这些提交一并拦掉，导致 destroy() 静默丢指标——而 SPA 组件卸载、热更新
    // 和 StrictMode 双次挂载都会走 destroy()。
    const monitor = core();
    monitor.use({
      name: 'final-sample',
      setup: () => {},
      teardown: () => {
        monitor.captureEvent('performance', { metric: 'LCP', value: 2_200, rating: 'good' });
      },
    });
    monitor.start();
    expect(monitor.transport.pending()).toBe(0);

    monitor.destroy();
    expect(monitor.transport.pending()).toBe(1);
  });

  it('discards signals that plugin setup produces as a side effect', () => {
    // 与上一条相对：setup 期间包装全局 API 顺带产生的信号属于 SDK 自身副作用，
    // 不应被当成业务事件记录。
    const monitor = core();
    monitor.use({
      name: 'noisy-setup',
      setup: () => {
        monitor.captureMessage('instrumentation side effect');
      },
      teardown: () => {},
    });
    monitor.start();
    expect(monitor.transport.pending()).toBe(0);
    monitor.destroy();
  });

  it('stops beforeSend from recursing when it captures during capture', () => {
    // beforeSend 在回调里再次采集会形成无限递归；采集路径需要自己的重入闸门。
    let reentered = 0;
    const monitor: MonitorCore = core({
      beforeSend: (event) => {
        reentered += 1;
        // 这次嵌套调用必须被拒绝，否则 beforeSend 会被反复触发直到爆栈。
        expect(monitor.captureMessage('nested')).toBeNull();
        return event;
      },
    });
    monitor.start();
    expect(monitor.captureMessage('outer')).toBeTruthy();
    expect(reentered).toBe(1);
    expect(monitor.transport.pending()).toBe(1);
    monitor.destroy();
  });

  it('normalizes invalid numeric options to safe transport bounds', () => {
    const monitor = core({
      sampleRate: Number.NaN,
      batchSize: 0,
      flushInterval: -1,
      maxRetries: -2,
      dedupeWindow: -10,
    });

    expect(monitor.options).toMatchObject({
      sampleRate: 1,
      batchSize: 1,
      flushInterval: 100,
      maxRetries: 0,
      dedupeWindow: 0,
    });
  });
});
