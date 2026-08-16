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
