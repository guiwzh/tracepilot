import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BreadcrumbInput,
  CapturePayload,
  MonitorOptions,
  PluginContext,
} from '../../src/types';
import { resolveOptions } from '../../src/core/options';
import { NetworkPlugin } from '../../src/plugins/NetworkPlugin';

const DSN = 'https://ingest.test/api/v1/envelopes';

/** 记录插件交给核心的 breadcrumb 与事件；配置经过与核心相同的规范化。 */
function recordingContext(overrides: Partial<MonitorOptions> = {}) {
  const breadcrumbs: BreadcrumbInput[] = [];
  const events: Array<{ type: string; payload: CapturePayload }> = [];
  const context: PluginContext = {
    options: resolveOptions({
      dsn: DSN,
      projectId: 'test-project',
      release: '1.0.0',
      environment: 'test',
      ...overrides,
    }),
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
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  private contentType: string | null = null;
  open(_method: string, _url: string | URL): void {}
  send(_body?: unknown): void {}
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-type' ? this.contentType : null;
  }
  get response(): unknown {
    return this.responseText;
  }
  finish(status: number, aborted = false, json?: unknown): void {
    this.status = status;
    if (json !== undefined) {
      this.contentType = 'application/json';
      this.responseText = JSON.stringify(json);
    }
    if (aborted) this.dispatchEvent(new Event('abort'));
    this.dispatchEvent(new Event('loadend'));
  }
}

/** 常见的业务码约定：code 为 0 表示成功。 */
function detectBusinessError({ body }: { body: unknown }) {
  const { code, message } = body as { code?: number; message?: string };
  return code === 0 ? null : { code, message };
}

function jsonResponse(body: unknown, status = 200, contentType = 'application/json') {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

let plugin: NetworkPlugin | undefined;

function install(overrides: Partial<MonitorOptions> = {}) {
  const recording = recordingContext(overrides);
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

  it('keeps 4xx responses as breadcrumbs by default and reports them when configured', async () => {
    // 401 登录过期、404 查无此项这类 4xx 常是预期内的，默认只记面包屑。
    vi.mocked(window.fetch).mockResolvedValue(new Response(null, { status: 404 }));
    const defaults = install();
    await window.fetch('https://api.test/orders/1001');
    expect(defaults.breadcrumbs.map((item) => item.message)).toEqual([
      'GET https://api.test/orders/1001 → 404',
    ]);
    expect(defaults.events).toEqual([]);
    plugin!.teardown();

    const strict = install({ failedRequestStatusCodes: [404, [500, 599]] });
    await window.fetch('https://api.test/orders/1001');
    expect(strict.events.map((item) => item.payload.status)).toEqual([404]);
  });

  it('reports a 200 response whose business code means failure', async () => {
    vi.mocked(window.fetch).mockResolvedValue(
      jsonResponse({ code: 40012, message: 'Coupon expired', data: null }),
    );
    const { breadcrumbs, events } = install({ detectBusinessError });

    const response = await window.fetch('https://api.test/coupon', { method: 'POST' });
    // 业务代码照常读取响应体：插件读的是克隆出来的那一份。
    expect(await response.json()).toMatchObject({ code: 40012 });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.payload).toMatchObject({
      status: 200,
      success: false,
      businessCode: 40012,
      businessMessage: 'Coupon expired',
    });
    // HTTP 层面的面包屑在响应到达时就记下；业务失败另补一条。
    expect(breadcrumbs.map((item) => item.message)).toEqual([
      'POST https://api.test/coupon → 200',
      'POST https://api.test/coupon → business error 40012',
    ]);
  });

  it('reads business codes of XHR responses when they finish', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { events } = install({ detectBusinessError });

    const failed = new FakeXhr();
    failed.open('post', 'https://api.test/checkout');
    failed.send();
    failed.finish(200, false, { code: 50001, message: 'Stock changed' });

    const passed = new FakeXhr();
    passed.open('get', 'https://api.test/cart');
    passed.send();
    passed.finish(200, false, { code: 0, data: [] });

    expect(events.map((item) => [item.payload.url, item.payload.businessCode])).toEqual([
      ['https://api.test/checkout', 50001],
    ]);
  });

  it('reads no body unless it is a 2xx JSON response and a detector is configured', async () => {
    const detect = vi.fn(detectBusinessError);
    const clone = vi.spyOn(Response.prototype, 'clone');
    // 插件装上之后 window.fetch 是它的包装，先拿住底下的替身。
    const fetchMock = vi.mocked(window.fetch);
    install({ detectBusinessError: detect });

    // 事件流、HTML 不是接口数据；克隆事件流还会把整条流缓存在内存里。
    fetchMock.mockResolvedValueOnce(
      new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
    await window.fetch('https://api.test/stream');
    // 非 2xx 已经按状态码判定过了。
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 1 }, 503));
    await window.fetch('https://api.test/pay');
    expect(clone).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
    plugin!.teardown();

    // 没有配置判定函数时，连 JSON 响应也不读。
    install();
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 1 }));
    await window.fetch('https://api.test/coupon');
    expect(clone).not.toHaveBeenCalled();

    // 对照：同样的响应，配置了判定函数就会克隆读取。
    plugin!.teardown();
    install({ detectBusinessError: detect });
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 1 }));
    await window.fetch('https://api.test/coupon');
    expect(clone).toHaveBeenCalledTimes(1);
  });

  it('treats a detector that throws as no business error', async () => {
    vi.mocked(window.fetch).mockResolvedValue(jsonResponse({ code: 1 }));
    const { events } = install({
      detectBusinessError: () => {
        throw new Error('bug in the integrator’s detector');
      },
    });

    const response = await window.fetch('https://api.test/coupon');
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
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
