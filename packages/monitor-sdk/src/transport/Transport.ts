import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL,
  type EventEnvelope,
  type MonitorEvent,
} from '@trace-pilot/shared';

/** 传输层只负责排队、批量、重试和页面退出发送，不理解具体事件语义。 */
interface TransportOptions {
  endpoint: string;
  dsnKey: string;
  batchSize: number;
  flushInterval: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export class Transport {
  private readonly queue: MonitorEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  // 同一时间只允许一个 flush，防止定时器和 batchSize 同时触发重复发送。
  private inFlight?: Promise<void>;
  private started = false;
  private readonly fetchImpl?: typeof fetch;
  private readonly onPageHide = () => void this.flush(true);
  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      void this.flush(true);
  };

  private readonly options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = {
      ...options,
      batchSize: boundedInteger(options.batchSize, DEFAULT_BATCH_SIZE, 1, 100),
      flushInterval: boundedInteger(options.flushInterval, DEFAULT_FLUSH_INTERVAL, 100, 86_400_000),
      maxRetries: boundedInteger(options.maxRetries, 2, 0, 10),
    };
    this.fetchImpl =
      options.fetchImpl ??
      // 保存绑定后的原生 fetch；直接传 window.fetch 可能丢失其 this。
      (typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : typeof fetch === 'function'
          ? fetch.bind(globalThis)
          : undefined);
  }

  static defaults(endpoint: string, dsnKey: string): TransportOptions {
    return {
      endpoint,
      dsnKey,
      batchSize: DEFAULT_BATCH_SIZE,
      flushInterval: DEFAULT_FLUSH_INTERVAL,
      maxRetries: 2,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.flush(), this.options.flushInterval);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  enqueue(event: MonitorEvent): void {
    this.queue.push(event);
    // fire-and-forget：采集 API 保持同步，不让业务代码等待网络。
    if (this.queue.length >= this.options.batchSize) void this.flush();
  }

  pending(): number {
    return this.queue.length;
  }

  async flush(preferBeacon = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return;
    // 先从队列取出批次；若最终失败，会在 catch 中按原顺序放回队首。
    const batch = this.queue.splice(0, this.options.batchSize);
    const envelope: EventEnvelope = {
      dsnKey: this.options.dsnKey,
      sentAt: Date.now(),
      events: batch,
    };
    const body = JSON.stringify(envelope);

    if (
      preferBeacon &&
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(this.options.endpoint, new Blob([body], { type: 'application/json' }))
    ) {
      // sendBeacon 专门用于页面离开阶段；浏览器接管请求，无需等待 Promise。
      return;
    }

    let delivered = false;
    this.inFlight = this.sendWithRetry(body)
      .then(() => {
        delivered = true;
      })
      .catch(() => {
        // 达到重试上限也不丢数据，留给下一次 flush 再尝试。
        this.queue.unshift(...batch);
      });
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
    if (delivered && this.queue.length >= this.options.batchSize) await this.flush();
  }

  private async sendWithRetry(body: string): Promise<void> {
    if (!this.fetchImpl) throw new Error('Fetch is unavailable');
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tracepilot-internal': '1' },
          body,
          keepalive: true,
        });
        if (!response.ok) throw new Error(`Ingest returned ${response.status}`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.options.maxRetries) {
          // 100ms、200ms、400ms……指数退避，且次数有硬上限。
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
      }
    }
    throw lastError;
  }

  destroy(): void {
    // 对称移除所有全局监听，避免 SPA 重挂载时重复上报。
    if (this.timer) clearInterval(this.timer);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.started = false;
    void this.flush(true);
  }
}
