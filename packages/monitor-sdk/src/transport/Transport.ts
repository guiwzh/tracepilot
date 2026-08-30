import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL,
  DEFAULT_MAX_QUEUE_SIZE,
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
  /** 队列可保留的事件上限，超出后拒绝新事件。 */
  maxQueueSize: number;
  fetchImpl?: typeof fetch;
}

/** 构造入参：数值项都会在构造函数里夹紧，因此调用方可以省略。 */
export type TransportInit = Omit<TransportOptions, 'maxQueueSize'> & { maxQueueSize?: number };

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export class Transport {
  private readonly queue: MonitorEvent[] = [];
  private droppedEvents = 0;
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

  constructor(options: TransportInit) {
    this.options = {
      ...options,
      batchSize: boundedInteger(options.batchSize, DEFAULT_BATCH_SIZE, 1, 100),
      flushInterval: boundedInteger(options.flushInterval, DEFAULT_FLUSH_INTERVAL, 100, 86_400_000),
      maxRetries: boundedInteger(options.maxRetries, 2, 0, 10),
      maxQueueSize: boundedInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 10, 10_000),
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
      maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
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
    // 队列必须有上限：服务端不可达时失败批次会被放回队首，错误风暴下没有上限就会
    // 一直占用宿主页面的内存。丢弃最新事件而不是最旧的——事故的最早证据诊断价值最高。
    if (this.queue.length >= this.options.maxQueueSize) {
      this.droppedEvents += 1;
      return;
    }
    this.queue.push(event);
    // fire-and-forget：采集 API 保持同步，不让业务代码等待网络。
    if (this.queue.length >= this.options.batchSize) void this.flush();
  }

  pending(): number {
    return this.queue.length;
  }

  /** 因队列已满而被丢弃的事件数，用于诊断错误风暴下的采集缺口。 */
  dropped(): number {
    return this.droppedEvents;
  }

  private envelopeBody(batch: MonitorEvent[]): string {
    const envelope: EventEnvelope = {
      dsnKey: this.options.dsnKey,
      sentAt: Date.now(),
      events: batch,
    };
    return JSON.stringify(envelope);
  }

  /**
   * 页面退出路径：把整个队列交给 sendBeacon，而不是只发一个批次。
   * 卸载随时可能发生，所以这里既不 await 在途请求，也不等待任何 Promise。
   * beacon 超出浏览器配额时返回 false，剩余事件退回 keepalive fetch 尽力送达。
   */
  private flushWithBeacon(): void {
    const canBeacon =
      typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
    while (canBeacon && this.queue.length > 0) {
      const batch = this.queue.slice(0, this.options.batchSize);
      const body = this.envelopeBody(batch);
      const accepted = navigator.sendBeacon(
        this.options.endpoint,
        new Blob([body], { type: 'application/json' }),
      );
      if (!accepted) break;
      this.queue.splice(0, batch.length);
    }
    if (this.queue.length === 0) return;
    // keepalive 允许请求在文档卸载后继续，是 beacon 不可用或被拒时的唯一兜底。
    const batch = this.queue.splice(0, this.options.batchSize);
    void this.sendWithRetry(this.envelopeBody(batch)).catch(() => {
      // 页面正在离开，没有下一次重试的机会，只能放弃这一批。
    });
  }

  async flush(preferBeacon = false): Promise<void> {
    // 退出路径必须先于 inFlight 判断：只要有一个普通 flush 在途，
    // 早期实现会直接返回那个 Promise，队列里的事件既不走 beacon 也随页面一起消失。
    if (preferBeacon) {
      this.flushWithBeacon();
      return;
    }
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return;
    // 先从队列取出批次；若最终失败，会在 catch 中按原顺序放回队首。
    const batch = this.queue.splice(0, this.options.batchSize);
    const body = this.envelopeBody(batch);

    let delivered = false;
    this.inFlight = this.sendWithRetry(body)
      .then(() => {
        delivered = true;
      })
      .catch(() => {
        // 达到重试上限也不丢数据，留给下一次 flush 再尝试。
        this.queue.unshift(...batch);
        // 放回后可能超出上限：服务端持续不可达时，这条路径是队列增长的真正来源。
        // 从队尾裁剪，保留最早的证据。
        if (this.queue.length > this.options.maxQueueSize) {
          this.droppedEvents += this.queue.length - this.options.maxQueueSize;
          this.queue.length = this.options.maxQueueSize;
        }
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
