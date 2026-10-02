import { DEFAULT_FAILED_STATUS_CODES } from '../core/options';
import { parseTraceparent, shouldPropagate } from '../core/trace';
import type { BusinessError, MonitorPlugin, PluginContext } from '../types';

/**
 * 通过轻量 monkey patch 包装 Fetch 与 XHR。
 *
 * 每个请求都记成一条 breadcrumb，作为之后错误的上下文；只有失败的请求才单独成为事件、
 * 进而聚合为 Issue。成功的请求不再各自上报：服务端没有任何地方消费它们，
 * 而每个事件都附带最多 50 条 breadcrumb，一个普通会话 30 个请求就能多出上百 KB 的上报。
 *
 * 什么算失败：
 * - 状态码落在 failedRequestStatusCodes 里（默认只有 5xx），或者拿不到响应的网络错误；
 * - 配置了 detectBusinessError 时，2xx 的 JSON 响应里业务码表示失败的也算；
 * - 被取消的请求（AbortController、组件卸载、查询库取消）和 no-cors 的 opaque 响应不算，只记 breadcrumb。
 *
 * 在 tracePropagationTargets 之内的请求还会带上 W3C traceparent 头（见 core/trace.ts），
 * 记录里的 traceId / spanId 就是后端链路里这次请求的位置。
 */
interface XhrMeta {
  method: string;
  url: string;
  startedAt: number;
  aborted: boolean;
  /** 应用自己用 setRequestHeader 设置的 traceparent；有它就不再加。 */
  traceparent?: string;
}

interface TraceIds {
  traceId: string;
  spanId: string;
}

interface RequestRecord {
  method: string;
  url: string;
  status: number;
  duration: number;
  /** 按失败规则判定的结果；false 且没有被取消的请求会成为事件。被取消的也是 false，另带 aborted。 */
  success: boolean;
  aborted?: boolean;
  error?: string;
  /** detectBusinessError 判定失败时返回的业务码和说明。 */
  businessCode?: string | number;
  businessMessage?: string;
  /** 请求带的 traceparent 里的 trace id 和 span id：SDK 加的，或者请求本来就带的。 */
  traceId?: string;
  spanId?: string;
}

/** 超过这个大小的响应体不解析业务码，避免在页面上为了监控解析大段 JSON。 */
const MAX_BUSINESS_BODY_BYTES = 256 * 1024;
const MAX_BUSINESS_MESSAGE = 200;

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true || (error as { name?: unknown } | null)?.name === 'AbortError';
}

function matchesStatus(status: number, codes: ReadonlyArray<number | [number, number]>): boolean {
  return codes.some((code) =>
    typeof code === 'number' ? status === code : status >= code[0] && status <= code[1],
  );
}

/** 业务码只看 2xx 的 JSON 响应：非 2xx 已经按状态码判定过了，其他类型（HTML、事件流）不是接口数据。 */
function readsBusinessBody(status: number, contentType: string | null, length: string | null) {
  return (
    status >= 200 &&
    status < 300 &&
    /json/i.test(contentType ?? '') &&
    !(Number(length) > MAX_BUSINESS_BODY_BYTES)
  );
}

/** XHR 的响应体在 loadend 时已经就绪，同步取出；取不到或不是 JSON 时返回 undefined。 */
function xhrJsonBody(xhr: XMLHttpRequest): unknown {
  if (xhr.responseType === 'json') return xhr.response ?? undefined;
  if (xhr.responseType !== '' && xhr.responseType !== 'text') return undefined;
  const text = xhr.responseText;
  if (text.length > MAX_BUSINESS_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class NetworkPlugin implements MonitorPlugin {
  readonly name = 'NetworkPlugin';
  private context?: PluginContext;
  private originalFetch?: typeof window.fetch;
  private originalOpen?: typeof XMLHttpRequest.prototype.open;
  private originalSend?: typeof XMLHttpRequest.prototype.send;
  private originalSetRequestHeader?: typeof XMLHttpRequest.prototype.setRequestHeader;
  // 自己装上的包装。teardown 时只有全局引用仍是它们才还原，见 teardown 的说明。
  private wrappedFetch?: typeof window.fetch;
  private wrappedOpen?: typeof XMLHttpRequest.prototype.open;
  private wrappedSend?: typeof XMLHttpRequest.prototype.send;
  private wrappedSetRequestHeader?: typeof XMLHttpRequest.prototype.setRequestHeader;
  // WeakMap 不阻止 XHR 对象被垃圾回收，适合保存每个实例的请求元数据。
  private readonly xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();

  setup(context: PluginContext): void {
    if (this.context || typeof window === 'undefined') return;
    this.context = context;
    this.patchFetch();
    this.patchXhr();
  }

  /**
   * 跳过 SDK 自己的上报请求，否则会出现“记录上报请求 → 再上报”的递归。
   * Transport 构造时保存了原生 fetch，正常情况下上报根本不经过这里；这道判断兜住的是
   * 另一个 SDK 实例在本插件之后创建、因而保存到了包装版本的情况。
   * 不用自定义请求头做标记：自定义头会让每次跨域上报多一次 CORS 预检。
   */
  private shouldObserve(url: string): boolean {
    return this.context !== undefined && !url.includes(this.context.options.dsn);
  }

  /** 这个地址的请求要不要带 traceparent（tracePropagationTargets，见 core/trace.ts）。 */
  private propagatesTo(url: string): boolean {
    return (
      this.context !== undefined &&
      shouldPropagate(url, this.context.options.tracePropagationTargets)
    );
  }

  /**
   * 范围内一个请求的 trace：已经带了 traceparent 的（应用自己或另一个链路 SDK 加的）不覆盖，
   * 记下它带的那个；没带的开一个新 span，由 add 加上。
   */
  private requestTrace(
    existing: string | null | undefined,
    add: (traceparent: string) => void,
  ): TraceIds | undefined {
    if (existing != null) return parseTraceparent(existing) ?? undefined;
    const span = this.context!.startRequestSpan();
    add(span.traceparent);
    return { traceId: span.traceId, spanId: span.spanId };
  }

  private patchFetch(): void {
    if (typeof window.fetch !== 'function') return;
    const original = window.fetch;
    this.originalFetch = original;
    this.wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = inputUrl(input);
      // teardown 之后包装可能还留在调用链上（见 teardown），此时只做透传。
      if (!this.shouldObserve(url)) return original.call(window, input, init);
      const request = input instanceof Request ? input : undefined;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const signal = init?.signal ?? request?.signal;
      // 要加 traceparent 时复制一份请求头、换一个新的 init 交给原生 fetch，不改动调用方传入的对象。
      // 给了 init.headers 时它整个取代 Request 自己的头，和 fetch 的语义一致。no-cors 请求不加：
      // 浏览器会悄悄丢掉不在安全列表里的请求头，记下来的 trace 后端根本没收到。
      let sentInit = init;
      let ids: TraceIds | undefined;
      if ((init?.mode ?? request?.mode) !== 'no-cors' && this.propagatesTo(url)) {
        const headers = new Headers(init?.headers ?? request?.headers);
        ids = this.requestTrace(headers.get('traceparent'), (traceparent) => {
          headers.set('traceparent', traceparent);
          sentInit = { ...init, headers };
        });
      }
      const startedAt = performance.now();
      try {
        const response = await original.call(window, input, sentInit);
        // no-cors 请求拿到的是 opaque 响应，状态码固定为 0，看不出成败，不能当作故障。
        const opaque = response.type === 'opaque' || response.type === 'opaqueredirect';
        const request: RequestRecord = {
          method,
          url,
          status: response.status,
          duration: performance.now() - startedAt,
          success: opaque || !this.failedStatus(response.status),
          ...ids,
        };
        this.record(request);
        if (
          request.success &&
          this.context?.options.detectBusinessError &&
          readsBusinessBody(
            response.status,
            response.headers.get('content-type'),
            response.headers.get('content-length'),
          )
        ) {
          // 读克隆出来的响应体，业务代码照常读原响应。异步进行、不等它：等它就得等整个响应体下载完，
          // 业务拿到响应的时间会被拖后。所以上面先记下 HTTP 层面的面包屑，之后的报错一定带着这次请求。
          try {
            void response
              .clone()
              .json()
              .then(
                (body: unknown) => this.checkBusiness(request, body),
                () => {},
              );
          } catch {
            // 克隆失败（例如响应体已被读走）就放弃这次业务码检查。
          }
        }
        return response;
      } catch (error) {
        const aborted = isAbort(error, signal);
        this.record({
          method,
          url,
          status: 0,
          duration: performance.now() - startedAt,
          success: false,
          ...(aborted
            ? { aborted: true }
            : { error: error instanceof Error ? error.message : String(error) }),
          ...ids,
        });
        // 采集后仍抛出原异常，不能改变业务代码对 fetch rejection 的处理语义。
        throw error;
      }
    };
    window.fetch = this.wrappedFetch;
  }

  private patchXhr(): void {
    if (typeof XMLHttpRequest === 'undefined') return;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    this.originalOpen = originalOpen;
    this.originalSend = originalSend;
    this.originalSetRequestHeader = originalSetRequestHeader;
    const xhrMeta = this.xhrMeta;
    // 包装函数里的 this 是 XHR 实例，插件自己的方法通过闭包取用。
    const shouldObserve = (url: string) => this.shouldObserve(url);
    const record = (request: RequestRecord) => this.record(request);
    const failedStatus = (status: number) => this.failedStatus(status);
    const checkBusiness = (request: RequestRecord, body: unknown) =>
      this.checkBusiness(request, body);
    const detectsBusiness = () => this.context?.options.detectBusinessError !== undefined;
    // XHR 读不到已经设置的请求头，要加 traceparent 之前只能靠包装 setRequestHeader 得知应用自己加过没有：
    // 同一个头设置两次，值会被拼成「a, b」。关闭传播（[]）时不包装。
    const traceXhr = (xhr: XMLHttpRequest, meta: XhrMeta): TraceIds | undefined => {
      if (!this.propagatesTo(meta.url)) return undefined;
      try {
        return this.requestTrace(meta.traceparent, (traceparent) =>
          originalSetRequestHeader.call(xhr, 'traceparent', traceparent),
        );
      } catch {
        // 状态不对（没有 open 或已经 send）时原生 send 自己会抛错，这里不加头就是了。
        return undefined;
      }
    };
    // open 阶段只有 method/url，send 阶段才真正开始计时。
    this.wrappedOpen = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      xhrMeta.set(this, {
        method: method.toUpperCase(),
        url: String(url),
        startedAt: 0,
        aborted: false,
      });
      return originalOpen.apply(this, [method, url, ...rest] as Parameters<typeof originalOpen>);
    } as typeof XMLHttpRequest.prototype.open;
    this.wrappedSend = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const meta = xhrMeta.get(this);
      if (!meta || !shouldObserve(meta.url)) return originalSend.call(this, body);
      const ids = traceXhr(this, meta);
      meta.startedAt = performance.now();
      const onAbort = () => {
        meta.aborted = true;
      };
      const done = () => {
        // loadend 无论成功、HTTP 失败、网络错误还是被取消都会触发，适合统一收口；abort 事件先于它。
        this.removeEventListener('abort', onAbort);
        this.removeEventListener('loadend', done);
        const request: RequestRecord = {
          method: meta.method,
          url: meta.url,
          status: this.status,
          duration: performance.now() - meta.startedAt,
          // 状态码 0 是拿不到响应：网络错误、跨域被拦、超时。被取消的与 fetch 一致：success 为 false，
          // 另外标记 aborted，只记面包屑、不成为事件。
          success: !meta.aborted && this.status !== 0 && !failedStatus(this.status),
          ...(meta.aborted ? { aborted: true } : {}),
          ...ids,
        };
        record(request);
        if (
          request.success &&
          detectsBusiness() &&
          readsBusinessBody(
            this.status,
            this.getResponseHeader('content-type'),
            this.getResponseHeader('content-length'),
          )
        ) {
          const body = xhrJsonBody(this);
          if (body !== undefined) checkBusiness(request, body);
        }
      };
      this.addEventListener('abort', onAbort);
      this.addEventListener('loadend', done);
      return originalSend.call(this, body);
    };
    XMLHttpRequest.prototype.open = this.wrappedOpen;
    XMLHttpRequest.prototype.send = this.wrappedSend;
    if (this.context?.options.tracePropagationTargets?.length !== 0) {
      this.wrappedSetRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
        const meta = xhrMeta.get(this);
        if (meta && name.toLowerCase() === 'traceparent') meta.traceparent = value;
        return originalSetRequestHeader.call(this, name, value);
      };
      XMLHttpRequest.prototype.setRequestHeader = this.wrappedSetRequestHeader;
    }
  }

  private record(request: RequestRecord): void {
    const context = this.context;
    if (!context) return;
    const outcome = request.aborted ? 'aborted' : String(request.status);
    context.addBreadcrumb({
      type: 'network',
      category: 'http',
      message: `${request.method} ${request.url} → ${outcome}`,
      data: { ...request },
    });
    if (!request.success && !request.aborted) {
      context.captureEvent('network', { ...request }, { traceId: request.traceId });
    }
  }

  private failedStatus(status: number): boolean {
    const codes = this.context?.options.failedRequestStatusCodes ?? DEFAULT_FAILED_STATUS_CODES;
    return matchesStatus(status, codes);
  }

  /**
   * 用接入方的 detectBusinessError 判定 2xx 响应里的业务码。判定为失败时补一条面包屑并上报事件：
   * HTTP 层面的面包屑在响应到达时已经记下（状态码 200），这一条说明它在业务上失败了。
   */
  private checkBusiness(request: RequestRecord, body: unknown): void {
    const context = this.context;
    const detect = context?.options.detectBusinessError;
    if (!context || !detect) return;
    let failure: BusinessError | null | undefined;
    try {
      failure = detect({ method: request.method, url: request.url, status: request.status, body });
    } catch {
      // 接入方的判定函数抛错，当作没有业务错误；不能让它影响业务页面。
      return;
    }
    if (!failure || typeof failure !== 'object') return;
    const code = failure.code;
    const failed: RequestRecord = {
      ...request,
      success: false,
      ...(typeof code === 'string' || typeof code === 'number' ? { businessCode: code } : {}),
      ...(failure.message === undefined
        ? {}
        : { businessMessage: String(failure.message).slice(0, MAX_BUSINESS_MESSAGE) }),
    };
    context.addBreadcrumb({
      type: 'network',
      category: 'http',
      message: `${request.method} ${request.url} → business error${code === undefined ? '' : ` ${String(code)}`}`,
      data: { ...failed },
    });
    context.captureEvent('network', { ...failed }, { traceId: failed.traceId });
  }

  teardown(): void {
    // 全局 API 要恢复到 SDK 启动前的引用，保障宿主应用和热更新环境。但只有当前引用仍是自己的包装时
    // 才还原：如果之后又有别的库包了一层，直接还原会把它的包装一起抹掉。那种情况下自己的包装留在
    // 调用链上，context 已清空，它只做透传。
    if (typeof window !== 'undefined' && this.wrappedFetch && window.fetch === this.wrappedFetch) {
      window.fetch = this.originalFetch!;
    }
    if (typeof XMLHttpRequest !== 'undefined') {
      const prototype = XMLHttpRequest.prototype;
      if (this.wrappedOpen && prototype.open === this.wrappedOpen) {
        prototype.open = this.originalOpen!;
      }
      if (this.wrappedSend && prototype.send === this.wrappedSend) {
        prototype.send = this.originalSend!;
      }
      if (
        this.wrappedSetRequestHeader &&
        prototype.setRequestHeader === this.wrappedSetRequestHeader
      ) {
        prototype.setRequestHeader = this.originalSetRequestHeader!;
      }
    }
    this.context = undefined;
    this.wrappedFetch = undefined;
    this.wrappedOpen = undefined;
    this.wrappedSend = undefined;
    this.wrappedSetRequestHeader = undefined;
  }
}
