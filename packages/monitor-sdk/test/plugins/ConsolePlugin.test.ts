import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveOptions } from '../../src/core/options';
import { ConsolePlugin } from '../../src/plugins/ConsolePlugin';
import type { BreadcrumbInput, ConsoleLevel, PluginContext } from '../../src/types';
import { TraceContext } from '../../src/core/trace';

const realConsole = { log: console.log, warn: console.warn, error: console.error };
let printed: Record<'log' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
let plugin: ConsolePlugin | undefined;

function install(consoleBreadcrumbs?: ConsoleLevel[] | false) {
  const breadcrumbs: BreadcrumbInput[] = [];
  const context: PluginContext = {
    options: resolveOptions({
      dsn: 'https://ingest.test/api/v1/envelopes',
      projectId: 'test-project',
      release: '1.0.0',
      environment: 'test',
      consoleBreadcrumbs,
    }),
    captureEvent: () => null,
    addBreadcrumb: (breadcrumb) => void breadcrumbs.push(breadcrumb),
    startRequestSpan: () => new TraceContext().startRequestSpan(),
  };
  plugin = new ConsolePlugin();
  plugin.setup(context);
  return breadcrumbs;
}

beforeEach(() => {
  // 换成替身，测试时控制台不输出，也能确认原方法照常被调用。
  printed = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.assign(console, printed);
});

afterEach(() => {
  plugin?.teardown();
  plugin = undefined;
  Object.assign(console, realConsole);
});

describe('ConsolePlugin', () => {
  it('records warnings and errors as breadcrumbs and still prints them', () => {
    const breadcrumbs = install();
    console.warn('Inventory response omitted warehouseId');
    console.error(new TypeError('cart.total is undefined'));
    console.log('render', 42);

    expect(breadcrumbs).toEqual([
      {
        type: 'console',
        category: 'console.warn',
        message: 'Inventory response omitted warehouseId',
        data: { level: 'warn' },
      },
      {
        type: 'console',
        category: 'console.error',
        message: 'TypeError: cart.total is undefined',
        data: { level: 'error' },
      },
    ]);
    // 默认不记 log：它太多，会把 50 条的缓冲挤满。
    expect(printed.log).toHaveBeenCalledWith('render', 42);
    expect(printed.error).toHaveBeenCalledTimes(1);
  });

  it('previews objects one level deep and masks sensitive keys', () => {
    const breadcrumbs = install();
    console.error('Request failed', {
      status: 500,
      token: 'secret-value',
      body: { items: [1, 2, 3] },
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(breadcrumbs[0]!.message).toBe(
      'Request failed {status: 500, token: [REDACTED], body: {…}, tags: […]}',
    );
    console.error(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(breadcrumbs[1]!.message).toBe('["a", "b", "c", "d", "e", …]');
  });

  it('never lets a failing argument break the application’s console call', () => {
    const breadcrumbs = install();
    const hostile = {
      get detail(): string {
        throw new Error('getter blew up');
      },
    };
    expect(() => console.error('Unexpected state', hostile)).not.toThrow();
    expect(printed.error).toHaveBeenCalledWith('Unexpected state', hostile);
    expect(breadcrumbs).toEqual([]);
  });

  it('follows the configured levels and can be switched off', () => {
    const breadcrumbs = install(['log']);
    console.log('checkout mounted');
    console.warn('not recorded');
    expect(breadcrumbs.map((item) => item.category)).toEqual(['console.log']);
    plugin!.teardown();

    install(false);
    expect(console.warn).toBe(printed.warn);
  });

  it('restores console methods on teardown only while its own wrappers are installed', () => {
    install();
    plugin!.teardown();
    expect(console.error).toBe(printed.error);

    const breadcrumbs = install();
    const ours = console.error;
    const theirs = (...args: unknown[]) => ours(...args);
    console.error = theirs;
    plugin!.teardown();
    expect(console.error).toBe(theirs);
    // 留在调用链上的旧包装只做透传，不再记录。
    console.error('after teardown');
    expect(breadcrumbs).toEqual([]);
    expect(printed.error).toHaveBeenCalledWith('after teardown');
  });
});
