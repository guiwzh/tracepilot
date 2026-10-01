import { afterEach, describe, expect, it } from 'vitest';
import { DEBUG_ID_REGISTRY, type MonitorEvent } from '@trace-pilot/shared';
import { MonitorCore } from '../../src/core/MonitorCore';

const APP_ID = '6f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b';
const LAZY_ID = '0e9d8c7b-6a59-4483-9271-605f4e3d2c1b';

/** 插件注入的代码在文件顶层 new Error()，登记表的键就是它的 stack：第一帧是这个文件自己。 */
function register(stack: string, debugId: unknown) {
  const global = globalThis as Record<string, unknown>;
  const registry = (global[DEBUG_ID_REGISTRY] ??= {}) as Record<string, unknown>;
  registry[stack] = debugId;
}

function capture(stack: string): MonitorEvent {
  const events: MonitorEvent[] = [];
  const monitor = new MonitorCore({
    dsn: 'http://localhost/envelopes',
    dsnKey: 'test-key',
    projectId: 'test-project',
    release: '1.0.0',
    environment: 'test',
    batchSize: 100,
    beforeSend: (event) => {
      events.push(event);
      return event;
    },
  });
  monitor.start();
  const error = new Error('boom');
  error.stack = stack;
  monitor.captureException(error);
  monitor.destroy();
  return events[0]!;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[DEBUG_ID_REGISTRY];
  sessionStorage.clear();
});

describe('debug IDs', () => {
  it('sends no debug IDs when the app was not built with the plugin', () => {
    expect(
      capture('Error: boom\n    at a (https://shop.test/assets/app.js:1:10)'),
    ).not.toHaveProperty('debugIds');
  });

  it('reports the debug ID of each file in the stack once, without query strings', () => {
    // Chrome 的登记表键；Firefox / Safari 的格式是「@url:行:列」。
    register('Error\n    at https://shop.test/assets/app-3f9a.js?v=2:1:31', APP_ID);
    register('@https://shop.test/assets/vendor-77aa.js:1:31\n', LAZY_ID);
    const event = capture(
      [
        'TypeError: boom',
        '    at submit (https://shop.test/assets/app-3f9a.js?v=2:1:420)',
        '    at retry (https://shop.test/assets/app-3f9a.js?v=2:1:900)',
        '    at https://cdn.other.test/widget.js:3:7',
      ].join('\n'),
    );
    expect(event.debugIds).toEqual([
      { file: 'https://shop.test/assets/app-3f9a.js', debugId: APP_ID },
    ]);
  });

  it('picks up chunks that registered after an earlier error', () => {
    register('Error\n    at https://shop.test/assets/app.js:1:31', APP_ID);
    const stack = 'Error: boom\n    at load (https://shop.test/assets/lazy.js:1:5)';
    expect(capture(stack)).not.toHaveProperty('debugIds');
    // 懒加载的 chunk 执行时才往登记表里写。
    register('Error\n    at https://shop.test/assets/lazy.js:1:31', LAZY_ID);
    expect(capture(stack).debugIds).toEqual([
      { file: 'https://shop.test/assets/lazy.js', debugId: LAZY_ID },
    ]);
  });

  it('ignores registry entries it cannot use', () => {
    register('Error\n    at https://shop.test/assets/app.js:1:31', 42);
    register('no frames here', APP_ID);
    expect(
      capture('Error: boom\n    at a (https://shop.test/assets/app.js:1:10)'),
    ).not.toHaveProperty('debugIds');
  });
});
