import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL,
  DEFAULT_MAX_QUEUE_SIZE,
  type MonitorEvent,
} from '@trace-pilot/shared';

/**
 * 传输层只负责排队、批量、重试和页面退出发送，不理解具体事件语义。
 *
 * 两条发送路径受的约束完全不同：
 *
 * - 普通发送：不带 keepalive 的 fetch。keepalive 请求的请求体共享浏览器 64 KiB 的在途配额，
 *   超出直接以 TypeError 失败。早期实现给所有请求都加了 keepalive，一批 10 个带完整
 *   breadcrumb 的错误事件约 180 KB，于是每次发送都失败，失败批次又被放回队首，
 *   后面的事件全部卡死在它身后。
 * - 退出发送：页面正在卸载，只能用 sendBeacon（或 keepalive fetch），它们受同一个 64 KiB
 *   配额约束。所以退出路径按字节切块，浏览器拒收的部分写进 localStorage，下次加载时补发。
 *
 * 两条路径都用 text/plain 发送 JSON：它是 CORS 安全列表里的类型，跨域不触发预检。
 * application/json 的 sendBeacon 需要带凭据的预检，接入端不允许凭据时 sendBeacon 照样返回 true，
 * 但真正的 POST 从未发出——事件就这样在退出时静默丢失。
 *
 * 投递语义是「至少一次」：同一事件可能被 beacon 和在途请求各发一次，
 * 由服务端按 eventId 幂等去重，客户端不追求恰好一次。
 */

/** keepalive 与 sendBeacon 共享的在途配额是 64 KiB（按请求体字节计），这里取 60 000 留出余量。 */
const KEEPALIVE_BUDGET_BYTES = 60_000;
/** 单个事件的上限；保证任何一个事件都能单独放进一次退出发送。 */
const DEFAULT_MAX_EVENT_BYTES = 32_000;
/** 普通批次的上限，低于服务端 1 MiB 的请求体限制。 */
const DEFAULT_MAX_BATCH_BYTES = 512_000;
/** 退出时持久化到 localStorage 的上限，避免撑满同源 5 MB 左右的配额。 */
const DEFAULT_MAX_STORED_BYTES = 256_000;
/** payload 中超过这个长度的字符串（通常是异常栈）先被截断，再考虑裁剪 breadcrumb。 */
const MAX_PAYLOAD_STRING = 4_000;

type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface TransportOptions {
  endpoint: string;
  dsnKey: string;
  batchSize: number;
  flushInterval: number;
  maxRetries: number;
  /** 队列可保留的事件上限，超出后拒绝新事件。 */
  maxQueueSize: number;
  maxEventBytes: number;
  maxBatchBytes: number;
  /** 退出时发不完的事件写到哪里；null 表示不持久化。 */
  storage: PendingStorage | null;
  fetchImpl?: typeof fetch;
}

/** 构造入参：数值项都会在构造函数里夹紧，因此调用方可以省略。 */
export type TransportInit = Pick<
  TransportOptions,
  'endpoint' | 'dsnKey' | 'batchSize' | 'flushInterval' | 'maxRetries' | 'fetchImpl'
> &
  Partial<Pick<TransportOptions, 'maxQueueSize' | 'maxEventBytes' | 'maxBatchBytes' | 'storage'>>;

interface QueuedEvent {
  event: MonitorEvent;
  /** 入队时序列化一次，后续计算批次字节数和拼装请求体都复用它。 */
  json: string;
  bytes: number;
}

type SendOutcome = 'delivered' | 'rejected' | 'failed';

export interface TransportStats {
  pending: number;
  dropped: {
    /** 队列已满时到达的新事件。 */
    queueFull: number;
    /** 裁剪后仍超过单事件上限的事件。 */
    oversize: number;
    /** 服务端明确拒收（4xx）的批次，重试也不会成功，直接丢弃以免堵住队列。 */
    rejected: number;
    /** 服务端持续不可达、失败批次放回队列后超出上限而被裁掉的事件。 */
    overflow: number;
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

/** 不分配内存地计算 UTF-8 字节数；浏览器配额按字节计，而 string.length 是 UTF-16 码元数。 */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对编码为 4 字节，并且占两个码元。
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

// 408 超时、429 限流和 5xx 可能是暂时的；其余 4xx 说明请求本身不被接受，重试没有意义。
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultStorage(): PendingStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari 隐私模式或禁用站点数据时，访问 localStorage 本身就会抛错。
    return null;
  }
}

export class Transport {
  private readonly queue: QueuedEvent[] = [];
  private readonly drops = { queueFull: 0, oversize: 0, rejected: 0, overflow: 0 };
  private timer?: ReturnType<typeof setInterval>;
  // 同一时间只允许一个排空循环，定时器和 batchSize 触发的 flush 都复用它。
  private draining?: Promise<void>;
  // 正在网络上的批次。退出时把它一并交给 beacon，否则页面卸载会连同在途请求一起丢掉它。
  private inFlight?: QueuedEvent[];
  private inFlightHandedToBeacon = false;
  // 本页曾把事件持久化过，队列排空后要删除那份副本，避免下次加载重复补发。
  private persisted = false;
  private started = false;
  private readonly fetchImpl?: typeof fetch;
  private readonly storageKey: string;
  private readonly envelopeOverhead: number;
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
      maxEventBytes: boundedInteger(
        options.maxEventBytes,
        DEFAULT_MAX_EVENT_BYTES,
        1_000,
        KEEPALIVE_BUDGET_BYTES - 1_000,
      ),
      maxBatchBytes: boundedInteger(
        options.maxBatchBytes,
        DEFAULT_MAX_BATCH_BYTES,
        KEEPALIVE_BUDGET_BYTES,
        900_000,
      ),
      storage: options.storage === undefined ? defaultStorage() : options.storage,
    };
    this.fetchImpl =
      options.fetchImpl ??
      // 保存绑定后的原生 fetch：之后 NetworkPlugin 会替换 window.fetch，SDK 自己的上报不能经过它。
      (typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : typeof fetch === 'function'
          ? fetch.bind(globalThis)
          : undefined);
    this.storageKey = `tracepilot:pending:${options.dsnKey}`;
    this.envelopeOverhead = utf8Length(this.envelopeBody([]));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.restorePersisted();
    this.timer = setInterval(() => void this.flush(), this.options.flushInterval);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (this.queue.length > 0) void this.flush();
  }

  enqueue(event: MonitorEvent): void {
    // 队列必须有上限：服务端不可达时失败批次会被放回队首，错误风暴下没有上限就会
    // 一直占用宿主页面的内存。丢弃最新事件而不是最旧的——事故的最早证据诊断价值最高。
    // 先判断容量再序列化，风暴中被拒的事件不必付出 JSON.stringify 的开销。
    if (this.queue.length >= this.options.maxQueueSize) {
      this.drops.queueFull += 1;
      return;
    }
    const item = this.prepare(event);
    if (!item) {
      this.drops.oversize += 1;
      return;
    }
    this.queue.push(item);
    // fire-and-forget：采集 API 保持同步，不让业务代码等待网络。
    if (this.queue.length >= this.options.batchSize) void this.flush();
  }

  pending(): number {
    return this.queue.length;
  }

  /** 各种原因丢弃的事件总数，用于诊断错误风暴下的采集缺口。 */
  dropped(): number {
    const { queueFull, oversize, rejected, overflow } = this.drops;
    return queueFull + oversize + rejected + overflow;
  }

  stats(): TransportStats {
    return { pending: this.queue.length, dropped: { ...this.drops } };
  }

  /**
   * 把事件序列化并压到单事件上限以内。超限时依次：
   * 1. 截断 payload 里的超长字符串（通常是几千行的异常栈，尾部帧诊断价值很低）；
   * 2. 从最旧的一端丢 breadcrumb——离报错最近的操作最有诊断价值；
   * 3. 仍然超限就放弃这个事件。
   * 被裁剪的事件会带上标记，调查时能知道证据不完整。
   */
  private prepare(event: MonitorEvent): QueuedEvent | null {
    const limit = this.options.maxEventBytes;
    let candidate = event;
    let json = JSON.stringify(candidate);
    let bytes = utf8Length(json);
    if (bytes <= limit) return { event: candidate, json, bytes };

    let truncated = false;
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.payload)) {
      if (typeof value === 'string' && value.length > MAX_PAYLOAD_STRING) {
        payload[key] = `${value.slice(0, MAX_PAYLOAD_STRING)}…[truncated]`;
        truncated = true;
      } else {
        payload[key] = value;
      }
    }
    if (truncated) payload.truncated = true;

    let breadcrumbs = event.breadcrumbs;
    candidate = { ...event, payload };
    json = JSON.stringify(candidate);
    bytes = utf8Length(json);
    while (bytes > limit && breadcrumbs.length > 0) {
      // 每轮丢掉最旧的四分之一，最多十几轮就能收敛，不必逐条重新序列化。
      breadcrumbs = breadcrumbs.slice(Math.ceil(breadcrumbs.length / 4));
      candidate = {
        ...event,
        payload: { ...payload, trimmedBreadcrumbs: event.breadcrumbs.length - breadcrumbs.length },
        breadcrumbs,
      };
      json = JSON.stringify(candidate);
      bytes = utf8Length(json);
    }
    return bytes <= limit ? { event: candidate, json, bytes } : null;
  }

  /** 从队首开始，数出不超过条数与字节上限的事件个数；至少返回 1，避免单个大事件卡住队列。 */
  private batchLength(items: QueuedEvent[], maxCount: number, maxBytes: number): number {
    let bytes = this.envelopeOverhead;
    let count = 0;
    while (count < items.length && count < maxCount) {
      // 事件之间还有一个逗号。
      const next = items[count]!.bytes + (count > 0 ? 1 : 0);
      if (count > 0 && bytes + next > maxBytes) break;
      bytes += next;
      count += 1;
    }
    return count;
  }

  private envelopeBody(batch: QueuedEvent[]): string {
    // 直接拼接入队时缓存的 JSON，不再对整批事件重新 stringify。
    return `{"dsnKey":${JSON.stringify(this.options.dsnKey)},"sentAt":${Date.now()},"events":[${batch
      .map((item) => item.json)
      .join(',')}]}`;
  }

  async flush(preferBeacon = false): Promise<void> {
    // 退出路径必须先于排空判断：只要有一个普通 flush 在途，
    // 早期实现会直接返回那个 Promise，队列里的事件既不走 beacon 也随页面一起消失。
    if (preferBeacon) {
      this.flushOnExit();
      return;
    }
    if (this.draining) return this.draining;
    if (this.queue.length === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    // 循环直到队列为空，而不是只发一批：调用方 await flush() 时期望的是「都发出去了」。
    while (this.queue.length > 0) {
      const count = this.batchLength(
        this.queue,
        this.options.batchSize,
        this.options.maxBatchBytes,
      );
      const batch = this.queue.splice(0, count);
      this.inFlight = batch;
      this.inFlightHandedToBeacon = false;
      const outcome = await this.send(this.envelopeBody(batch));
      const handedToBeacon = this.inFlightHandedToBeacon;
      this.inFlight = undefined;

      if (outcome === 'rejected') {
        // 不可重试的拒收：丢掉这一批并继续，绝不能让它堵在队首。
        this.drops.rejected += batch.length;
        continue;
      }
      if (outcome === 'failed') {
        // 页面退出时这批已经交给了 beacon，再放回队列只会重复发送。
        if (!handedToBeacon) this.requeue(batch);
        // 服务端不可达：留给下一次定时 flush，不在这里空转。
        return;
      }
    }
    if (this.persisted) this.clearPersisted();
  }

  private requeue(batch: QueuedEvent[]): void {
    this.queue.unshift(...batch);
    // 放回后可能超出上限：服务端持续不可达时，这条路径是队列增长的真正来源。
    // 从队尾裁剪，保留最早的证据。
    if (this.queue.length > this.options.maxQueueSize) {
      this.drops.overflow += this.queue.length - this.options.maxQueueSize;
      this.queue.length = this.options.maxQueueSize;
    }
  }

  private async send(body: string): Promise<SendOutcome> {
    if (!this.fetchImpl) return 'failed';
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body,
        });
        if (response.ok) return 'delivered';
        if (!isRetryableStatus(response.status)) return 'rejected';
      } catch {
        // 网络错误：可能是暂时离线，按可重试处理。
      }
      if (attempt < this.options.maxRetries) {
        // 100ms、200ms、400ms……指数退避，且次数有硬上限。
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    return 'failed';
  }

  /**
   * 页面退出路径。卸载随时可能发生，所以这里全程同步：不 await 任何 Promise。
   *
   * 待发事件 = 在途批次 + 队列。按 64 KiB 配额切块交给 sendBeacon，浏览器拒收（配额用尽）就停下；
   * 没有 sendBeacon 时退回一次 keepalive fetch。剩下的写入 localStorage，下次加载时补发。
   *
   * 注意 visibilitychange 在切换标签页时也会触发，页面并不一定真的卸载：
   * 所以持久化的事件仍留在队列里继续正常发送，只有交给 beacon 的才移出队列。
   */
  private flushOnExit(): void {
    const inFlight = this.inFlight && !this.inFlightHandedToBeacon ? this.inFlight : [];
    const candidates = [...inFlight, ...this.queue];
    if (candidates.length === 0) return;

    let sent = 0;
    const canBeacon =
      typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
    if (canBeacon) {
      while (sent < candidates.length) {
        const count = this.batchLength(
          candidates.slice(sent),
          Number.POSITIVE_INFINITY,
          KEEPALIVE_BUDGET_BYTES,
        );
        const body = this.envelopeBody(candidates.slice(sent, sent + count));
        let accepted: boolean;
        try {
          accepted = navigator.sendBeacon(
            this.options.endpoint,
            new Blob([body], { type: 'text/plain;charset=UTF-8' }),
          );
        } catch {
          accepted = false;
        }
        if (!accepted) break;
        sent += count;
      }
    } else if (this.fetchImpl) {
      const count = this.batchLength(candidates, Number.POSITIVE_INFINITY, KEEPALIVE_BUDGET_BYTES);
      // keepalive 允许请求在文档卸载后继续；它与 beacon 共享配额，所以只发一块。
      void this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: this.envelopeBody(candidates.slice(0, count)),
        keepalive: true,
      }).catch(() => {
        // 页面正在离开，没有重试的机会；这一块已经同时写进了持久化副本。
      });
      // 发起了不代表送达，这一块照样写入持久化副本，补发时由服务端幂等去重。
      this.persist(candidates);
      return;
    }

    if (sent >= inFlight.length && inFlight.length > 0) this.inFlightHandedToBeacon = true;
    // 交给 beacon 的事件移出队列；在途批次不在队列里，只需要打上标记。
    const sentFromQueue = Math.max(0, sent - inFlight.length);
    this.queue.splice(0, sentFromQueue);
    this.persist(candidates.slice(sent));
  }

  private persist(items: QueuedEvent[]): void {
    const storage = this.options.storage;
    if (!storage) return;
    if (items.length === 0) {
      if (this.persisted) this.clearPersisted();
      return;
    }
    const kept: string[] = [];
    let bytes = 2;
    for (const item of items) {
      if (bytes + item.bytes + 1 > DEFAULT_MAX_STORED_BYTES) break;
      kept.push(item.json);
      bytes += item.bytes + 1;
    }
    try {
      storage.setItem(this.storageKey, `[${kept.join(',')}]`);
      this.persisted = true;
    } catch {
      // 配额用尽或存储被禁用：只能放弃持久化，不能让退出路径抛错。
    }
  }

  private restorePersisted(): void {
    const storage = this.options.storage;
    if (!storage) return;
    let events: MonitorEvent[] = [];
    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) return;
      // 先删再补发：即使这一轮又没发完，退出路径也会把它们重新写回来。
      storage.removeItem(this.storageKey);
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) events = parsed as MonitorEvent[];
    } catch {
      return;
    }
    for (const event of events) {
      if (event && typeof event === 'object' && typeof event.eventId === 'string') {
        this.enqueue(event);
      }
    }
  }

  private clearPersisted(): void {
    try {
      this.options.storage?.removeItem(this.storageKey);
    } catch {
      // 同 persist：存储不可用时没有更好的处理方式。
    }
    this.persisted = false;
  }

  destroy(): void {
    // 对称移除所有全局监听，避免 SPA 重挂载时重复上报。
    if (this.timer) clearInterval(this.timer);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.started = false;
    this.flushOnExit();
  }
}
