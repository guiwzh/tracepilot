import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { createMonitor } from '../../src/index';
import { ErrorPlugin } from '../../src/plugins/ErrorPlugin';
import { NetworkPlugin } from '../../src/plugins/NetworkPlugin';
import type { MonitorPlugin, PluginContext } from '../../src/types';
import { MonitorCore } from '../../src/core/MonitorCore';

// 直接实例化核心，隔离验证插件幂等、短窗口去重、脱敏和 beforeSend 边界。
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

/** 退出发送交给 sendBeacon 的全部事件（setup.ts 已把它换成不出网的替身）。 */
async function beaconEvents(): Promise<MonitorEvent[]> {
  const calls = vi.mocked(navigator.sendBeacon).mock.calls;
  const bodies = await Promise.all(calls.map(([, body]) => (body as Blob).text()));
  return bodies.flatMap((body) => (JSON.parse(body) as { events: MonitorEvent[] }).events);
}

/** 用 beforeSend 截下核心最终交给传输层的事件。 */
function capturing(overrides: Partial<ConstructorParameters<typeof MonitorCore>[0]> = {}) {
  const events: MonitorEvent[] = [];
  const monitor = core({
    ...overrides,
    beforeSend: (event) => {
      events.push(event);
      return event;
    },
  });
  return { monitor, events };
}

afterEach(() => {
  sessionStorage.clear();
});

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
    expect(monitor.stats().pending).toBe(1);
    monitor.destroy();
  });

  it('reports an error that keeps recurring once per window instead of only once', () => {
    // 回归：被挡下的重复曾刷新窗口，每 3 秒一次的错误只在第一次上报，之后再也不上报。
    vi.useFakeTimers();
    try {
      const monitor = core({ dedupeWindow: 5_000 });
      monitor.start();
      const reported: number[] = [];
      for (let second = 0; second <= 12; second += 3) {
        vi.setSystemTime(Date.UTC(2026, 8, 28, 12, 0, second));
        if (monitor.captureException(new Error('polling failed'))) reported.push(second);
      }
      expect(reported).toEqual([0, 6, 12]);
      monitor.destroy();
    } finally {
      vi.useRealTimers();
    }
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

  it('carries a custom fingerprint on the event without mixing it into the payload', () => {
    const { monitor, events } = capturing();
    monitor.start();
    monitor.captureException(
      new Error('timed out'),
      { step: 'payment' },
      { fingerprint: ['{{ default }}', 'tenant-a'] },
    );
    monitor.captureException(new Error('plain'));
    expect(events[0]).toMatchObject({
      fingerprint: ['{{ default }}', 'tenant-a'],
      payload: { message: 'timed out', step: 'payment' },
    });
    expect(events[0]!.payload).not.toHaveProperty('fingerprint');
    expect(events[1]).not.toHaveProperty('fingerprint');
    monitor.destroy();
  });

  it('lets a plugin submit its final sample while tearing down', async () => {
    // PerformancePlugin 的最终 LCP/CLS/INP 是在 teardown 里提交的。生命周期闸门
    // 曾经把这些提交一并拦掉，导致 destroy() 静默丢指标——而 SPA 组件卸载、热更新
    // 和 StrictMode 双次挂载都会走 destroy()。
    const monitor = core();
    let context: PluginContext | undefined;
    monitor.use({
      name: 'final-sample',
      setup: (value) => {
        context = value;
      },
      teardown: () => {
        context?.captureEvent('performance', { metric: 'LCP', value: 2_200, rating: 'good' });
      },
    });
    monitor.start();
    expect(monitor.stats().pending).toBe(0);

    monitor.destroy();
    // 核心先 teardown 插件、最后才销毁传输层，这个样本随退出发送一起交给了浏览器。
    expect((await beaconEvents()).map((event) => event.payload.metric)).toEqual(['LCP']);
  });

  it('delivers what a plugin added after createMonitor submits on teardown', async () => {
    // 回归：传输层曾是一个必须最后注册的插件。createMonitor(...).use(插件) 让新插件排在它后面，
    // 新插件收尾时提交的事件留在已经销毁的队列里，一个 beacon 都没有发出。
    let context: PluginContext | undefined;
    const monitor = createMonitor({
      dsn: 'http://localhost/envelopes',
      projectId: 'test-project',
      release: '1.0.0',
      environment: 'test',
    }).use({
      name: 'session-summary',
      setup: (value) => {
        context = value;
      },
      teardown: () => {
        context?.captureEvent('error', { name: 'Message', message: 'final summary' });
      },
    });
    monitor.start();
    monitor.destroy();

    expect((await beaconEvents()).map((event) => event.payload.message)).toContain('final summary');
  });

  it('sends on its own schedule when plugins are composed by hand', async () => {
    // 回归：手动组合 MonitorCore 与插件而漏掉传输插件时，事件永远停在队列里。
    const monitor = core({ flushInterval: 100 }).use(new ErrorPlugin());
    monitor.start();
    monitor.captureException(new Error('composed by hand'));

    await vi.waitFor(() => expect(monitor.stats().delivered).toBe(1));
    expect(vi.mocked(window.fetch)).toHaveBeenCalledTimes(1);
    monitor.destroy();
  });

  it('asks plugins for their last samples before the exit flush', async () => {
    const monitor = core();
    let context: PluginContext | undefined;
    monitor.start();
    // start 之后才注册的插件同样赶得上：核心的页面隐藏监听早于传输层注册，并在事件发生时遍历全部插件。
    monitor.use({
      name: 'late-reporter',
      setup: (value) => {
        context = value;
      },
      teardown: () => {},
      onPageHidden: () => {
        context?.captureEvent('performance', { metric: 'CLS', value: 0.2, rating: 'good' });
      },
    });

    window.dispatchEvent(new Event('pagehide'));
    expect((await beaconEvents()).map((event) => event.payload.metric)).toEqual(['CLS']);
    monitor.destroy();
  });

  it('discards signals that plugin setup produces as a side effect', () => {
    // 与上一条相对：setup 期间包装全局 API 顺带产生的信号属于 SDK 自身副作用，
    // 不应被当成业务事件记录。
    const monitor = core();
    monitor.use({
      name: 'noisy-setup',
      setup: (context) => {
        context.captureEvent('error', { name: 'Message', message: 'instrumentation side effect' });
      },
      teardown: () => {},
    });
    monitor.start();
    expect(monitor.stats().pending).toBe(0);
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
    expect(monitor.stats().pending).toBe(1);
    monitor.destroy();
  });

  it('samples whole sessions so an error never loses the context around it', () => {
    // 按事件采样会让一条错误被采到、而它之前的请求没被采到，证据链因此断裂。
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const skipped = core({ sampleRate: 0.5 });
    const plugin = { name: 'probe', setup: vi.fn(), teardown: vi.fn() };
    skipped.use(plugin).start();
    expect(skipped.captureMessage('dropped')).toBeNull();
    // 未采样的会话连插件都不安装，宿主页面不承担包装全局 API 的开销。
    expect(plugin.setup).not.toHaveBeenCalled();
    skipped.destroy();
    expect(plugin.teardown).not.toHaveBeenCalled();

    // 同一标签页会话里，刷新后的新实例沿用之前抽到的签，而不是重新抽。
    random.mockReturnValue(0.1);
    const reloaded = core({ sampleRate: 0.5 });
    reloaded.start();
    expect(reloaded.captureMessage('still dropped')).toBeNull();
    reloaded.destroy();

    // 调整采样率不重新抽签：调高只会多采一些会话，原来采中的会话不会因此掉出去。
    const raised = core({ sampleRate: 0.95 });
    raised.start();
    expect(raised.captureMessage('now sampled')).toBeTruthy();
    raised.destroy();
  });

  it('samples performance on its own rate and never drops errors with it', () => {
    // 抽签值 0.6 落在性能采样的一半之外：这个会话不上报性能样本，错误照常上报。
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    const skipped = capturing({ performanceSampleRate: 0.5 });
    skipped.monitor.start();
    expect(skipped.monitor.captureEvent('performance', { metric: 'LCP', value: 1_200 })).toBeNull();
    expect(skipped.monitor.captureException(new Error('still reported'))).toBeTruthy();
    expect(skipped.events.map((event) => event.eventType)).toEqual(['error']);
    skipped.monitor.destroy();

    // 另一个标签页会话抽到 0.3：两类都上报，事件带上各自生效的采样率。
    sessionStorage.clear();
    random.mockReturnValue(0.3);
    const sampled = capturing({ sampleRate: 0.8, performanceSampleRate: 0.5 });
    sampled.monitor.start();
    sampled.monitor.captureEvent('performance', { metric: 'LCP', value: 1_200 });
    sampled.monitor.captureException(new Error('reported'));
    expect(sampled.events.map((event) => [event.eventType, event.sampleRate])).toEqual([
      ['performance', 0.4],
      ['error', 0.8],
    ]);
    sampled.monitor.destroy();
  });

  it('touches no storage and reports a full sample rate by default', () => {
    const getItem = vi.spyOn(sessionStorage, 'getItem');
    const { monitor, events } = capturing();
    monitor.start();
    monitor.captureException(new Error('boom'));
    expect(events[0]!.sampleRate).toBe(1);
    expect(getItem).not.toHaveBeenCalled();
    monitor.destroy();

    // 对照：有采样率小于 1 时才读取 sessionStorage 里的抽签值。
    core({ performanceSampleRate: 0.5 }).destroy();
    expect(getItem).toHaveBeenCalledWith('tracepilot:sampled:test-project');
  });

  it('deduplicates Firefox and Safari stacks by their first frame', () => {
    // V8 的栈首行是消息本身；Firefox / Safari 没有消息行，第一行就是栈帧。
    const monitor = core({ dedupeWindow: 10_000 });
    monitor.start();
    const firefoxError = (column: number, fn = 'calculateTotal') =>
      Object.assign(new Error('total is undefined'), {
        stack: `${fn}@https://shop.test/assets/app.js:1:${column}\nsubmit@https://shop.test/assets/app.js:1:900`,
      });

    expect(monitor.captureException(firefoxError(420))).toBeTruthy();
    // 同一位置、列号随构建变化：视为重复。
    expect(monitor.captureException(firefoxError(421))).toBeNull();
    // 不同的首帧是另一个问题。
    expect(monitor.captureException(firefoxError(420, 'applyPromotion'))).toBeTruthy();
    monitor.destroy();
  });

  it('deduplicates resources and failed requests that differ only in numbers or query', () => {
    const monitor = core({ dedupeWindow: 10_000 });
    monitor.start();
    const image = (index: number) => ({
      tagName: 'img',
      url: `https://shop.test/thumbs/product-${index}.png?v=${index}`,
    });
    expect(monitor.captureEvent('resource', image(17))).toBeTruthy();
    expect(monitor.captureEvent('resource', image(18))).toBeNull();
    expect(
      monitor.captureEvent('resource', { tagName: 'script', url: 'https://shop.test/a.js' }),
    ).toBeTruthy();

    const request = (id: number, status: number) => ({
      method: 'GET',
      url: `https://api.test/orders/${id}`,
      status,
      success: false,
    });
    expect(monitor.captureEvent('network', request(1001, 503))).toBeTruthy();
    expect(monitor.captureEvent('network', request(1002, 503))).toBeNull();
    // 同一个接口的另一种失败是新的证据。
    expect(monitor.captureEvent('network', request(1002, 500))).toBeTruthy();
    // 指标样本不参与去重：同一指标的新值必须送达，服务端按 metricId 覆盖。
    expect(monitor.captureEvent('performance', { metric: 'LCP', value: 1 })).toBeTruthy();
    expect(monitor.captureEvent('performance', { metric: 'LCP', value: 1 })).toBeTruthy();
    monitor.destroy();
  });

  it('ignores errors that carry no diagnosable information by default', () => {
    const monitor = core({ ignoreErrors: ['Third-party widget', /^Loading chunk \d+ failed/] });
    monitor.start();
    const capture = (payload: Record<string, unknown>) => monitor.captureEvent('error', payload);

    expect(capture({ name: 'Error', message: 'Script error.' })).toBeNull();
    expect(
      capture({
        name: 'Error',
        message: 'ResizeObserver loop completed with undelivered notifications.',
      }),
    ).toBeNull();
    expect(capture({ name: 'Error', message: 'ResizeObserver loop limit exceeded' })).toBeNull();
    expect(
      capture({
        name: 'TypeError',
        message: 'x is null',
        filename: 'chrome-extension://abc/content.js',
      }),
    ).toBeNull();
    expect(
      capture({
        name: 'TypeError',
        message: 'y is null',
        stack: 'TypeError: y is null\n    at inject (moz-extension://abc/inject.js:1:20)',
      }),
    ).toBeNull();
    expect(capture({ name: 'Error', message: 'Third-party widget crashed' })).toBeNull();
    expect(capture({ name: 'ChunkLoadError', message: 'Loading chunk 42 failed.' })).toBeNull();
    expect(capture({ name: 'TypeError', message: 'cart.total is undefined' })).toBeTruthy();
    monitor.destroy();
  });

  it('reports the cause chain of a wrapped error under its own stack', () => {
    const { monitor, events } = capturing();
    monitor.start();
    const network = new TypeError('Failed to fetch');
    network.stack =
      'TypeError: Failed to fetch\n    at request (https://shop.test/assets/api.js:3:14)';
    const failure = new Error('Checkout failed', { cause: network });
    failure.stack =
      'Error: Checkout failed\n    at submit (https://shop.test/assets/checkout.js:8:2)';
    monitor.captureException(failure);

    expect(events[0]!.payload.stack).toBe(
      [
        'Error: Checkout failed',
        '    at submit (https://shop.test/assets/checkout.js:8:2)',
        'Caused by: TypeError: Failed to fetch',
        '    at request (https://shop.test/assets/api.js:3:14)',
      ].join('\n'),
    );
    monitor.destroy();
  });

  it('stops a cause chain at a cycle, and describes causes that are not errors', () => {
    const { monitor, events } = capturing({ dedupeWindow: 0 });
    monitor.start();
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    (first as { cause?: unknown }).cause = second;
    first.stack = 'Error: first';
    second.stack = 'Error: second';
    monitor.captureException(first);
    monitor.captureException(new Error('Validation failed', { cause: { field: 'email' } }));

    expect(events[0]!.payload.stack).toBe('Error: first\nCaused by: Error: second');
    expect(String(events[1]!.payload.stack)).toContain('Caused by: {"field":"email"}');
    monitor.destroy();
  });

  it('keeps what it has when reading a cause throws, instead of throwing at the caller', () => {
    const { monitor, events } = capturing();
    monitor.start();
    const outer = new Error('Checkout failed', { cause: new Error('Inventory lookup failed') });
    outer.stack = 'Error: Checkout failed';
    (outer.cause as Error).stack = 'Error: Inventory lookup failed';
    Object.defineProperty(outer.cause, 'cause', {
      get() {
        throw new Error('getter blew up');
      },
    });

    expect(() => monitor.captureException(outer)).not.toThrow();
    expect(events[0]!.payload.stack).toBe(
      'Error: Checkout failed\nCaused by: Error: Inventory lookup failed',
    );
    monitor.destroy();
  });

  it('merges repeated console breadcrumbs so a noisy loop cannot flush the evidence', () => {
    const { monitor, events } = capturing();
    monitor.start();
    monitor.addBreadcrumb({ type: 'click', category: 'ui.click', message: 'button#pay' });
    for (let index = 0; index < 30; index += 1) {
      monitor.addBreadcrumb({
        type: 'console',
        category: 'console.warn',
        message: 'Price is stale',
        data: { level: 'warn' },
      });
    }
    monitor.captureException(new Error('payment failed'));

    expect(
      events[0]!.breadcrumbs.map((item) => [item.type, item.message, item.data?.count]),
    ).toEqual([
      ['click', 'button#pay', undefined],
      ['console', 'Price is stale', 30],
    ]);
    monitor.destroy();
  });

  it('uses the page a signal happened on when one is given, scrubbed like any other', () => {
    const { monitor, events } = capturing();
    monitor.start();
    monitor.captureEvent(
      'performance',
      { metric: 'LCP', value: 2_400 },
      { page: { url: 'https://shop.test/landing?token=secret', route: '/landing' } },
    );
    expect(events[0]!.page).toEqual({ url: 'https://shop.test/landing', route: '/landing' });
    monitor.destroy();
  });

  it('puts the page view’s trace id on events once a request has carried it to a backend', async () => {
    const { monitor, events } = capturing();
    // 插件装上之后 window.fetch 是它的包装，先拿住底下的替身。
    const fetchMock = vi.mocked(window.fetch);
    monitor.use(new NetworkPlugin()).start();

    // 这次页面浏览里还没有请求带过 trace：后端没见过它，事件上不写。
    monitor.captureException(new Error('render failed before any request'));
    await window.fetch('/api/cart');
    const traceId = new Headers(fetchMock.mock.calls[0]![1]!.headers)
      .get('traceparent')!
      .split('-')[1];
    monitor.captureException(new Error('cart.summary is undefined'));
    // 指标样本不属于任何 Issue，不带。
    monitor.captureEvent('performance', { metric: 'LCP', value: 2_200 });
    // 显式给出的 trace id 优先，不合法的忽略。
    monitor.captureEvent(
      'network',
      { method: 'GET', url: '/api/a', status: 503, success: false },
      { traceId: '0af7651916cd43dd8448eb211c80319c' },
    );
    monitor.captureEvent(
      'network',
      { method: 'GET', url: '/api/b', status: 503, success: false },
      { traceId: 'not-a-trace-id' },
    );
    // 换了页面：新的 trace，还没有请求带过它。
    history.pushState({}, '', '/orders');
    monitor.captureException(new Error('orders failed'));
    history.replaceState({}, '', '/');

    expect(events.map((event) => event.traceId)).toEqual([
      undefined,
      traceId,
      undefined,
      '0af7651916cd43dd8448eb211c80319c',
      traceId,
      undefined,
    ]);
    monitor.destroy();
  });

  it('keeps breadcrumbs off metric samples but on events that form issues', () => {
    const { monitor, events } = capturing();
    monitor.start();
    monitor.addBreadcrumb({ type: 'click', category: 'ui.click', message: 'button#pay' });
    monitor.captureEvent('performance', { metric: 'LCP', value: 2_200 });
    monitor.captureEvent('network', { method: 'POST', url: '/pay', status: 503, success: false });
    monitor.captureException(new Error('payment failed'));

    expect(events.map((event) => [event.eventType, event.breadcrumbs.length])).toEqual([
      ['performance', 0],
      ['network', 1],
      ['error', 1],
    ]);
    monitor.destroy();
  });

  it('scrubs URLs and secrets before beforeSend without breaking stack line numbers', () => {
    history.replaceState({}, '', '/checkout/review?session=abc123#step-2');
    const { monitor, events } = capturing();
    monitor.start();
    monitor.addBreadcrumb({
      type: 'network',
      category: 'http',
      message: 'GET /api/cart?token=secret → 200',
      data: { url: 'https://api.test/cart?token=secret', authorization: 'Bearer abc' },
    });
    monitor.captureException(
      Object.assign(new Error('Failed to load https://cdn.test/app.js?sig=secret'), {
        stack:
          'Error: Failed to load https://cdn.test/app.js?sig=secret\n' +
          '    at load (https://cdn.test/app.js?v=3:1:420)\n' +
          '    at run@https://cdn.test/vendor.js?t=99#x:2:15',
      }),
      { apiKey: 'sk-live-123' },
    );

    const [event] = events;
    expect(event!.page.url).toBe(`${location.origin}/checkout/review`);
    expect(event!.payload).toMatchObject({
      message: 'Failed to load https://cdn.test/app.js',
      apiKey: '[REDACTED]',
    });
    // 栈帧只删查询参数，行列号保留，服务端才能用 Source Map 还原。
    expect(String(event!.payload.stack).split('\n')).toEqual([
      'Error: Failed to load https://cdn.test/app.js',
      '    at load (https://cdn.test/app.js:1:420)',
      '    at run@https://cdn.test/vendor.js:2:15',
    ]);
    expect(event!.breadcrumbs[0]).toMatchObject({
      message: 'GET /api/cart → 200',
      data: { url: 'https://api.test/cart', authorization: '[REDACTED]' },
    });
    monitor.destroy();
    history.replaceState({}, '', '/');
  });

  it('keeps the hash route of a hash-routed app but not its parameters', () => {
    // hash 路由的应用靠片段区分页面：事件的 route、白屏消息这类带路由的文字都要保留它，
    // 路由自己的参数照样去掉。
    history.replaceState({}, '', '/app#/checkout?coupon=private');
    const { monitor, events } = capturing();
    monitor.start();
    monitor.captureMessage('Blank page on /app#/checkout?coupon=private');

    expect(events[0]!.page).toMatchObject({
      url: `${location.origin}/app#/checkout`,
      route: '/app#/checkout',
    });
    expect(events[0]!.payload.message).toBe('Blank page on /app#/checkout');
    monitor.destroy();
    history.replaceState({}, '', '/');
  });

  it('reports through flush() whether events actually reached the server', async () => {
    const monitor = core({ maxRetries: 0 });
    vi.mocked(window.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    monitor.start();
    monitor.captureMessage('checkout degraded', 'warning');

    const failed = await monitor.flush();
    expect(failed).toMatchObject({ pending: 1, delivered: 0, lastFailure: { status: null } });

    const recovered = await monitor.flush();
    expect(recovered).toMatchObject({ pending: 0, delivered: 1 });
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
