import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BreadcrumbInput,
  CapturePayload,
  PluginContext,
  ResolvedMonitorOptions,
} from '../../src/types';
import { NetworkPlugin } from '../../src/plugins/NetworkPlugin';

const DSN = 'https://ingest.test/api/v1/envelopes';

/** 记录插件交给核心的 breadcrumb 与事件。 */
function recordingContext() {
  const breadcrumbs: BreadcrumbInput[] = [];
  const events: Array<{ type: string; payload: CapturePayload }> = [];
  const context: PluginContext = {
    options: { dsn: DSN } as ResolvedMonitorOptions,
    captureEvent: (type, payload) => {
      events.push({ type, payload });
      return 'event-id';
    },
    addBreadcrumb: (breadcrumb) => void breadcrumbs.push(breadcrumb),
  };
  return { context, breadcrumbs, events };
}

/** 可以手动决定结果的 XHR 替身：插件包装的是它的 prototype。 */
class FakeXhr extends EventTarget {
  status = 0;
  open(_method: string, _url: string | URL): void {}
  send(_body?: unknown): void {}
  finish(status: number, aborted = false): void {
    this.status = status;
    if (aborted) this.dispatchEvent(new Event('abort'));
    this.dispatchEvent(new Event('loadend'));
  }
}

let plugin: NetworkPlugin | undefined;

function install() {
  const recording = recordingContext();
  plugin = new NetworkPlugin();
  plugin.setup(recording.context);
  return recording;
}

afterEach(() => {
  plugin?.teardown();
  plugin = undefined;
  vi.unstubAllGlobals();
});

describe('NetworkPlugin', () => {
  it('keeps successful requests as breadcrumbs only', async () => {
    vi.mocked(window.fetch).mockResolvedValue(new Response('{}', { status: 200 }));
    const { breadcrumbs, events } = install();

    await window.fetch('https://api.test/cart');

    expect(breadcrumbs.map((item) => item.message)).toEqual(['GET https://api.test/cart → 200']);
    expect(events).toEqual([]);
  });

  it('turns a failed request into an event as well as a breadcrumb', async () => {
    vi.mocked(window.fetch).mockResolvedValue(new Response(null, { status: 503 }));
    const { breadcrumbs, events } = install();

    await window.fetch('https://api.test/pay', { method: 'post' });

    expect(breadcrumbs.map((item) => item.message)).toEqual(['POST https://api.test/pay → 503']);
    expect(events).toEqual([
      {
        type: 'network',
        payload: expect.objectContaining({ method: 'POST', status: 503, success: false }),
      },
    ]);
  });

  it('records a network error and rethrows it unchanged', async () => {
    const failure = new TypeError('Failed to fetch');
    vi.mocked(window.fetch).mockRejectedValue(failure);
    const { events } = install();

    await expect(window.fetch('https://api.test/pay')).rejects.toBe(failure);
    expect(events[0]?.payload).toMatchObject({ status: 0, error: 'Failed to fetch' });
  });

  it('treats an aborted fetch as context, not as a failure', async () => {
    // 组件卸载、查询库取消请求都会走到这里；把它们报成故障，每次取消都会变成一个 Issue。
    vi.mocked(window.fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('signal is aborted without reason', 'AbortError')),
          );
        }),
    );
    const { breadcrumbs, events } = install();
    const controller = new AbortController();

    const request = window.fetch('https://api.test/slow', { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });

    expect(breadcrumbs.map((item) => item.message)).toEqual([
      'GET https://api.test/slow → aborted',
    ]);
    expect(events).toEqual([]);
  });

  it('does not treat an opaque no-cors response as a failure', async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, 'type', { value: 'opaque' });
    Object.defineProperty(opaque, 'status', { value: 0 });
    vi.mocked(window.fetch).mockResolvedValue(opaque);
    const { events } = install();

    await window.fetch('https://third-party.test/pixel', { mode: 'no-cors' });
    expect(events).toEqual([]);
  });

  it('skips the SDK’s own ingest requests', async () => {
    const { breadcrumbs } = install();
    await window.fetch(DSN, { method: 'POST', body: '{}' });
    expect(breadcrumbs).toEqual([]);
  });

  it('reports failed XHR requests and ignores aborted ones', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { breadcrumbs, events } = install();

    const failed = new FakeXhr();
    failed.open('get', 'https://api.test/inventory');
    failed.send();
    failed.finish(503);

    const aborted = new FakeXhr();
    aborted.open('get', 'https://api.test/search');
    aborted.send();
    aborted.finish(0, true);

    expect(breadcrumbs.map((item) => item.message)).toEqual([
      'GET https://api.test/inventory → 503',
      'GET https://api.test/search → aborted',
    ]);
    expect(events.map((item) => item.payload.url)).toEqual(['https://api.test/inventory']);
  });

  it('restores fetch on teardown only while its own wrapper is still installed', async () => {
    const original = window.fetch;
    install();
    plugin!.teardown();
    expect(window.fetch).toBe(original);

    // 另一个库在本插件之后又包了一层：teardown 不能把它的包装一起抹掉。
    const { breadcrumbs } = install();
    const ours = window.fetch;
    const theirs = vi.fn((input: RequestInfo | URL, init?: RequestInit) => ours(input, init));
    window.fetch = theirs as unknown as typeof fetch;
    plugin!.teardown();

    expect(window.fetch).toBe(theirs);
    // 留在调用链上的旧包装只做透传，不再记录。
    await window.fetch('https://api.test/after-teardown');
    expect(theirs).toHaveBeenCalledTimes(1);
    expect(breadcrumbs).toEqual([]);
    window.fetch = original;
  });
});
