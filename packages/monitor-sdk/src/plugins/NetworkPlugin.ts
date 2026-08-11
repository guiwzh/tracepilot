import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

interface XhrMeta {
  method: string;
  url: string;
  startedAt: number;
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export class NetworkPlugin implements MonitorPlugin {
  readonly name = 'NetworkPlugin';
  private core?: MonitorCore;
  private originalFetch?: typeof window.fetch;
  private originalOpen?: typeof XMLHttpRequest.prototype.open;
  private originalSend?: typeof XMLHttpRequest.prototype.send;
  private readonly xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();

  setup(core: MonitorCore): void {
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    this.patchFetch(core);
    this.patchXhr(core);
  }

  private patchFetch(core: MonitorCore): void {
    if (typeof window.fetch !== 'function') return;
    this.originalFetch = window.fetch;
    const original = this.originalFetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = inputUrl(input);
      if (
        url.includes(core.options.dsn) ||
        new Headers(init?.headers).has('x-tracepilot-internal')
      ) {
        return original.call(window, input, init);
      }
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const startedAt = performance.now();
      try {
        const response = await original.call(window, input, init);
        const duration = performance.now() - startedAt;
        this.record(core, { method, url, status: response.status, duration, success: response.ok });
        return response;
      } catch (error) {
        const duration = performance.now() - startedAt;
        this.record(core, {
          method,
          url,
          status: 0,
          duration,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }

  private patchXhr(core: MonitorCore): void {
    if (typeof XMLHttpRequest === 'undefined') return;
    this.originalOpen = XMLHttpRequest.prototype.open;
    this.originalSend = XMLHttpRequest.prototype.send;
    const xhrMeta = this.xhrMeta;
    const record = this.record.bind(this);
    const originalOpen = this.originalOpen;
    const originalSend = this.originalSend;
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      xhrMeta.set(this, { method: method.toUpperCase(), url: String(url), startedAt: 0 });
      return originalOpen.apply(this, [method, url, ...rest] as Parameters<typeof originalOpen>);
    };
    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = xhrMeta.get(this);
      if (!meta || meta.url.includes(core.options.dsn)) return originalSend.call(this, body);
      meta.startedAt = performance.now();
      const done = () => {
        this.removeEventListener('loadend', done);
        record(core, {
          method: meta.method,
          url: meta.url,
          status: this.status,
          duration: performance.now() - meta.startedAt,
          success: this.status >= 200 && this.status < 400,
        });
      };
      this.addEventListener('loadend', done);
      return originalSend.call(this, body);
    };
  }

  private record(core: MonitorCore, payload: Record<string, unknown>): void {
    const message = `${String(payload.method)} ${String(payload.url)} → ${String(payload.status)}`;
    core.addBreadcrumb({ type: 'network', category: 'http', message, data: payload });
    core.captureEvent('network', payload);
  }

  teardown(): void {
    if (typeof window !== 'undefined' && this.originalFetch) window.fetch = this.originalFetch;
    if (typeof XMLHttpRequest !== 'undefined') {
      if (this.originalOpen) XMLHttpRequest.prototype.open = this.originalOpen;
      if (this.originalSend) XMLHttpRequest.prototype.send = this.originalSend;
    }
    this.core = undefined;
  }
}
