import { afterEach, describe, expect, it } from 'vitest';
import type { CapturePayload, PluginContext, ResolvedMonitorOptions } from '../types';
import { ErrorPlugin } from './ErrorPlugin';
import { PromisePlugin } from './PromisePlugin';

function recordingContext() {
  const events: CapturePayload[] = [];
  const context: PluginContext = {
    options: {} as ResolvedMonitorOptions,
    captureEvent: (_type, payload) => {
      events.push(payload);
      return 'event-id';
    },
    addBreadcrumb: () => {},
  };
  return { context, events };
}

const installed: Array<{ teardown(): void }> = [];

afterEach(() => {
  for (const plugin of installed.splice(0)) plugin.teardown();
});

describe('ErrorPlugin', () => {
  it('describes the thrown error rather than the browser’s display message', () => {
    // 回归：曾优先使用 event.message，Chrome 给它加了 "Uncaught " 前缀。同一个错误经
    // captureException 上报时没有这个前缀，指纹不同，被拆成两个 Issue。
    const { context, events } = recordingContext();
    const plugin = new ErrorPlugin();
    plugin.setup(context);
    installed.push(plugin);

    const error = new TypeError("Cannot read properties of undefined (reading 'total')");
    window.dispatchEvent(
      new ErrorEvent('error', {
        error,
        message: `Uncaught ${error.name}: ${error.message}`,
        filename: 'https://shop.test/app.js',
        lineno: 1,
        colno: 420,
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'total')",
        filename: 'https://shop.test/app.js',
        line: 1,
        column: 420,
      }),
    ]);
  });

  it('falls back to the message when there is no error object', () => {
    const { context, events } = recordingContext();
    const plugin = new ErrorPlugin();
    plugin.setup(context);
    installed.push(plugin);

    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    // throw 一个字符串时 error 就是那个字符串。
    window.dispatchEvent(
      new ErrorEvent('error', { error: 'plain string', message: 'Uncaught plain string' }),
    );

    expect(events.map((event) => [event.name, event.message])).toEqual([
      ['Error', 'Script error.'],
      ['Error', 'plain string'],
    ]);
  });
});

describe('PromisePlugin', () => {
  it('captures unhandled rejections with any kind of reason', () => {
    const { context, events } = recordingContext();
    const plugin = new PromisePlugin();
    plugin.setup(context);
    installed.push(plugin);

    // happy-dom 没有 PromiseRejectionEvent，插件只读取 reason。
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), {
        reason: new Error('Payment intent was not initialized'),
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        name: 'Error',
        message: 'Payment intent was not initialized',
        mechanism: 'unhandledrejection',
      }),
    ]);
  });
});
