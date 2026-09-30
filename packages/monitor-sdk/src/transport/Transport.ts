import type { MonitorEvent } from '@trace-pilot/shared';
import { clampOption } from '../core/options';
import type { DeliveryStats } from '../types';

/**
 * 传输层只负责排队、批量、重试和页面退出发送，不理解具体事件语义。
 *
 * 两条发送路径受的约束完全不同：
 *
 * - 普通发送：不带 keepalive 的 fetch。keepalive 请求的请求体共享浏览器 64 KiB 的在途配额，
 *   超出直接以 TypeError 失败。早期实现给所有请求都加了 keepalive，一个带 50 条网络 breadcrumb
 *   的错误约 16 KB，一批 10 个约 165 KB，于是每次发送都失败，失败批次又被放回队首，
 *   后面的事件全部卡死在它身后。
 * - 退出发送：页面正在卸载，只能用 sendBeacon（或 keepalive fetch），它们受同一个 64 KiB
 *   配额约束。所以退出路径按字节切块，浏览器拒收的部分留在队列里：页面只是切到后台时稍后照常发送，
 *   真的卸载就丢失。发不完的事件不写进 localStorage 下次补发，这和 Sentry、Datadog 的默认做法一致：
 *   本地副本会占用业务应用的存储配额、在磁盘上留下明文数据，还要处理多个标签页争用同一份副本。
 *
 * 两条路径都用 text/plain 发送 JSON：它是 CORS 安全列表里的类型，跨域不触发预检。
 * application/json 的 sendBeacon 需要带凭据的预检，接入端不允许凭据时 sendBeacon 照样返回 true，
 * 但真正的 POST 从未发出——事件就这样在退出时静默丢失。
 *
 * 投递语义是「至少一次」：同一事件可能被 beacon 和在途请求各发一次，
 * 由服务端按 eventId 幂等去重，客户端不追求恰好一次。
 *
 * 服务端不可达时，自动发送按指数退避并加随机抖动，服务端给出 Retry-After 时照做：
 * 否则故障期间每个打开着的页面都按固定节奏持续打过来，恢复那一刻还会一拥而上。
 */

/** keepalive 与 sendBeacon 共享的在途配额是 64 KiB（按请求体字节计），这里取 60 000 留出余量。 */
const KEEPALIVE_BUDGET_BYTES = 60_000;
/** 单个事件的上限；保证任何一个事件都能单独放进一次退出发送。 */
const DEFAULT_MAX_EVENT_BYTES = 32_000;
/** 普通批次的上限，低于服务端 1 MiB 的请求体限制。 */
const DEFAULT_MAX_BATCH_BYTES = 512_000;
/** payload 中超过这个长度的字符串（通常是异常栈）先被截断，再考虑裁剪 breadcrumb。 */
const MAX_PAYLOAD_STRING = 4_000;
/** 连续失败时自动发送的最长间隔。 */
const MAX_BACKOFF_MS = 300_000;
/** 服务端要求的等待时间上限，防止一个异常的 Retry-After 让 SDK 长时间停摆。 */
const MAX_RETRY_AFTER_MS = 600_000;

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
  fetchImpl?: typeof fetch;
}

/** 构造入参：数值项都会在构造函数里夹紧，因此调用方可以省略。 */
export type TransportInit = Pick<
  TransportOptions,
  'endpoint' | 'dsnKey' | 'batchSize' | 'flushInterval' | 'maxRetries' | 'fetchImpl'
> &
  Partial<Pick<TransportOptions, 'maxQueueSize' | 'maxEventBytes' | 'maxBatchBytes'>>;

interface QueuedEvent {
  event: MonitorEvent;
  /** 入队时序列化一次，后续计算批次字节数和拼装请求体都复用它。 */
  json: string;
  bytes: number;
}

interface SendResult {
  outcome: 'delivered' | 'rejected' | 'failed';
  /** 最后一次响应的状态码；没有拿到响应（离线、连接被拒）时为 null。 */
  status: number | null;
  /** 服务端通过 Retry-After 要求的等待时间。 */
  retryAfterMs: number | null;
}

export type TransportStats = DeliveryStats;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

/**
 * 解析 Retry-After：秒数或 HTTP 日期。跨域响应里要读到它，服务端必须在
 * Access-Control-Expose-Headers 里列出它（它不在 CORS 默认可读的响应头里）。
 */
function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds)) return null;
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, milliseconds));
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

/** navigator.onLine 只在为 false 时可信：为 true 并不代表真的连得上。 */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
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
  private started = false;
  private delivered = 0;
  private lastFailure: DeliveryStats['lastFailure'] = null;
  // 连续失败的批次数，决定退避时长；任何一批送达后清零。
  private consecutiveFailures = 0;
  // 自动发送（定时器、攒够一批）不早于这个时间；只约束自动发送，调用方显式 flush() 不受影响。
  private backoffUntil = 0;
  // 服务端通过 Retry-After 要求的等待：显式 flush() 也要遵守。
  private retryAfterUntil = 0;
  private readonly fetchImpl?: typeof fetch;
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
      batchSize: clampOption('batchSize', options.batchSize),
      flushInterval: clampOption('flushInterval', options.flushInterval),
      maxRetries: clampOption('maxRetries', options.maxRetries),
      maxQueueSize: clampOption('maxQueueSize', options.maxQueueSize),
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
    };
    this.fetchImpl =
      options.fetchImpl ??
      // 保存绑定后的原生 fetch：之后 NetworkPlugin 会替换 window.fetch，SDK 自己的上报不能经过它。
      (typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : typeof fetch === 'function'
          ? fetch.bind(globalThis)
          : undefined);
    this.envelopeOverhead = utf8Length(this.envelopeBody([]));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.flushAutomatically(), this.options.flushInterval);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (this.queue.length > 0) void this.flushAutomatically();
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
    if (this.queue.length >= this.options.batchSize) void this.flushAutomatically();
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
    const nextAttemptAt = Math.max(this.backoffUntil, this.retryAfterUntil);
    return {
      pending: this.queue.length,
      delivered: this.delivered,
      dropped: { ...this.drops },
      lastFailure: this.lastFailure,
      nextAttemptAt: nextAttemptAt > Date.now() ? nextAttemptAt : null,
    };
  }

  /**
   * 把事件序列化并压到单事件上限以内。超限时依次：
   * 1. 截断 payload 里的超长字符串（通常是很长的异常栈）、保留开头：离出错点最近的帧在前面。
   *    代价是接在堆栈尾部的 cause 链会先被截掉；
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

  /**
   * 立即发送队列。调用方显式调用时不受退避约束，但服务端用 Retry-After 要求的等待仍要遵守。
   * preferBeacon 为 true 时走页面退出路径。
   */
  async flush(preferBeacon = false): Promise<void> {
    // 退出路径必须先于排空判断：只要有一个普通 flush 在途，
    // 早期实现会直接返回那个 Promise，队列里的事件既不走 beacon 也随页面一起消失。
    if (preferBeacon) {
      this.flushOnExit();
      return;
    }
    if (Date.now() < this.retryAfterUntil) return;
    return this.startDrain();
  }

  /** 定时器和「攒够一批」触发的发送：还在退避期内就跳过，等之后的某次触发。 */
  private flushAutomatically(): void {
    if (Date.now() < Math.max(this.backoffUntil, this.retryAfterUntil)) return;
    void this.startDrain();
  }

  private startDrain(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.queue.length === 0) return Promise.resolve();
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
      const result = await this.send(this.envelopeBody(batch));
      const handedToBeacon = this.inFlightHandedToBeacon;
      this.inFlight = undefined;

      if (result.outcome === 'delivered') {
        this.delivered += batch.length;
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
        continue;
      }
      this.lastFailure = { at: Date.now(), status: result.status };
      if (result.outcome === 'rejected') {
        // 不可重试的拒收：丢掉这一批并继续，绝不能让它堵在队首。
        this.drops.rejected += batch.length;
        continue;
      }
      // 页面退出时这批已经交给了 beacon，再放回队列只会重复发送。
      if (!handedToBeacon) this.requeue(batch);
      // 服务端不可达：进入退避，由之后的自动发送重试，不在这里空转。
      this.scheduleRetry(result.retryAfterMs);
      return;
    }
  }

  /**
   * 自动发送的退避：flushInterval × 2^(连续失败次数 − 1)，上限 5 分钟，再乘 0.5～1 的随机系数，
   * 让同时遇到故障的大量页面错开重试。服务端给了 Retry-After 时，按它和退避中较晚的一个。
   */
  private scheduleRetry(retryAfterMs: number | null): void {
    this.consecutiveFailures += 1;
    const exponential = Math.min(
      MAX_BACKOFF_MS,
      this.options.flushInterval * 2 ** (this.consecutiveFailures - 1),
    );
    this.backoffUntil = Date.now() + exponential * (0.5 + Math.random() * 0.5);
    if (retryAfterMs !== null) this.retryAfterUntil = Date.now() + retryAfterMs;
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

  private async send(body: string): Promise<SendResult> {
    if (!this.fetchImpl) return { outcome: 'failed', status: null, retryAfterMs: null };
    let status: number | null = null;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body,
        });
        status = response.status;
        if (response.ok) return { outcome: 'delivered', status, retryAfterMs: null };
        if (!isRetryableStatus(status)) return { outcome: 'rejected', status, retryAfterMs: null };
        const retryAfter = retryAfterMs(response.headers.get('retry-after'));
        // 限流（429）或服务端明确给出了等待时间：马上重试只会再被拒，交给跨周期的退避。
        if (status === 429 || retryAfter !== null) {
          return { outcome: 'failed', status, retryAfterMs: retryAfter };
        }
      } catch {
        // 网络错误：可能是暂时离线，按可重试处理。
        status = null;
      }
      if (attempt < this.options.maxRetries) {
        // 同一轮里的快速重试只为扛过瞬时抖动：100ms、200ms、400ms……次数有硬上限。
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    return { outcome: 'failed', status, retryAfterMs: null };
  }

  /**
   * 页面退出路径。卸载随时可能发生，所以这里全程同步：不 await 任何 Promise。
   *
   * 待发事件 = 在途批次 + 队列。按 64 KiB 配额切块交给 sendBeacon，浏览器拒收（配额用尽）就停下，
   * 发不出去的留在队列里；没有 sendBeacon 时退回一次 keepalive fetch。
   *
   * visibilitychange 在切换标签页时也会触发，页面并不一定真的卸载，所以要分清两种情况：
   * - 服务端正常：交给 beacon 的事件移出队列。beacon 没有回执，留着的话回到前台会再发一遍。
   * - 服务端正在失败（上一批没送达，还在退避）：beacon 多半也送不到，而它失败了不会重试。
   *   这时交给它只算多试一次，事件继续留在队列里，页面没有卸载就照常重试；
   *   万一 beacon 其实送达了，重复的那一份由服务端按 eventId 去重。
   * 浏览器明确处于离线状态时什么都发不出去，事件直接留在队列里。
   */
  private flushOnExit(): void {
    if (isOffline()) return;
    const inFlight = this.inFlight && !this.inFlightHandedToBeacon ? this.inFlight : [];
    const candidates = [...inFlight, ...this.queue];
    if (candidates.length === 0) return;

    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      if (!this.fetchImpl) return;
      const count = this.batchLength(candidates, Number.POSITIVE_INFINITY, KEEPALIVE_BUDGET_BYTES);
      // keepalive 允许请求在文档卸载后继续；它与 beacon 共享配额，所以只发一块。
      // 拿不到结果（页面可能正在卸载），事件留在队列里：页面没有卸载就照常再发，由服务端去重。
      void this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: this.envelopeBody(candidates.slice(0, count)),
        keepalive: true,
      }).catch(() => {
        // 页面正在离开，没有重试的机会。
      });
      return;
    }

    let sent = 0;
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

    if (this.consecutiveFailures > 0) return;
    if (sent >= inFlight.length && inFlight.length > 0) this.inFlightHandedToBeacon = true;
    // 交给 beacon 的事件移出队列；在途批次不在队列里，只需要打上标记。
    this.queue.splice(0, Math.max(0, sent - inFlight.length));
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
