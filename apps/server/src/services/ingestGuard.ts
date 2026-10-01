import type { RateLimitReason } from '@trace-pilot/shared';

/**
 * 接入保护：每个项目两道闸，在入站过滤之后、入库之前判定一整个信封收不收。
 *
 * 1. **限流（令牌桶）**：每个项目每分钟最多 N 个事件。桶按 N/60 每秒的速度补充令牌，最多攒 10 秒的量
 *    （至少 100 个，一个信封最多 100 个事件，否则一个满信封永远进不来）。允许短时间的突发，长期平均不超过 N。
 *    这是硬上限，保护的是服务端：一个项目打满了，别的项目的接入不受影响。
 * 2. **突增保护**：当前这一分钟收下的事件超过「过去一小时每分钟平均值 × 10」（且不低于每分钟 600 个）时，
 *    拒收超出的部分到这一分钟结束。保护的是数据：一次发版带进一个死循环里的报错，几分钟就能刷出平时
 *    几天的量，把真正的新问题淹没在同一个 Issue 的几万条重复里。阈值随常态自适应：平时量大的项目阈值也高，
 *    只计收下的事件，所以持续的新常态会在一小时里逐渐被接受。与 Sentry 的 Spike Protection 同一思路。
 *
 * 拒收时返回 429 和 Retry-After：SDK 照它退避，队列满了就丢弃新事件，而不是继续猛发。
 * 整个信封要么都收、要么都不收：SDK 把被拒的一批原样留在队列里，过一会儿重发。
 *
 * 状态在进程内存里：单进程部署够用；多实例要放到 Redis 之类的共享存储（INCR + 过期时间，或 GCRA），
 * 见 docs/server.md 的已知限制。进程重启后突增保护的基线从零开始，这段时间里按下限（600 个/分钟）判断。
 */

/** 突增阈值的下限（每分钟）：量很小的项目，偶尔一分钟几十上百个错误不算突增。 */
export const SPIKE_FLOOR_PER_MINUTE = 600;
/** 超过过去一小时每分钟平均值的多少倍算突增。 */
export const SPIKE_MULTIPLIER = 10;
/** 计算基线的窗口：过去多少分钟。 */
const BASELINE_MINUTES = 60;
const MINUTE = 60_000;

export interface IngestLimits {
  /** 每分钟最多接收的事件数；0 表示不限。 */
  eventsPerMinute: number;
  spikeProtection: boolean;
}

export type GuardDecision =
  { ok: true } | { ok: false; reason: RateLimitReason; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** 桶是按哪个限额建的；项目设置改了限额，就按新限额重建。 */
  eventsPerMinute: number;
}

interface ProjectState {
  bucket?: Bucket;
  /** 每分钟收下的事件数，键是分钟序号（时间戳 ÷ 60 秒），只保留最近一小时。 */
  minutes: Map<number, number>;
}

function capacityOf(eventsPerMinute: number): number {
  return Math.max(100, eventsPerMinute / 6);
}

export class IngestGuard {
  private readonly projects = new Map<string, ProjectState>();

  /**
   * 判定这个项目的 count 个事件收不收。收下时扣掉令牌、计入这一分钟；拒收时什么都不改，
   * 两道闸都过了才一起生效（不会出现被突增保护拒收、却已经扣了令牌的情况）。
   */
  admit(projectId: string, count: number, limits: IngestLimits, now = Date.now()): GuardDecision {
    const state = this.stateOf(projectId);
    const minute = Math.floor(now / MINUTE);

    let bucket: Bucket | undefined;
    if (limits.eventsPerMinute > 0) {
      bucket = this.refill(state, limits.eventsPerMinute, now);
      if (bucket.tokens < count) {
        const perSecond = limits.eventsPerMinute / 60;
        return {
          ok: false,
          reason: 'project-rate-limit',
          retryAfterSeconds: Math.max(1, Math.ceil((count - bucket.tokens) / perSecond)),
        };
      }
    }

    if (limits.spikeProtection) {
      const current = state.minutes.get(minute) ?? 0;
      if (current + count > this.spikeThreshold(state, minute)) {
        return {
          ok: false,
          reason: 'spike-protection',
          retryAfterSeconds: Math.max(1, Math.ceil(((minute + 1) * MINUTE - now) / 1000)),
        };
      }
    }

    if (bucket) {
      bucket.tokens -= count;
      state.bucket = bucket;
    }
    state.minutes.set(minute, (state.minutes.get(minute) ?? 0) + count);
    for (const key of state.minutes.keys()) {
      if (key < minute - BASELINE_MINUTES) state.minutes.delete(key);
    }
    return { ok: true };
  }

  /** 这一分钟最多收多少个：过去一小时（不含这一分钟）每分钟平均值的 10 倍，不低于下限。 */
  private spikeThreshold(state: ProjectState, minute: number): number {
    let total = 0;
    for (const [key, value] of state.minutes) {
      if (key >= minute - BASELINE_MINUTES && key < minute) total += value;
    }
    return Math.max(SPIKE_FLOOR_PER_MINUTE, (SPIKE_MULTIPLIER * total) / BASELINE_MINUTES);
  }

  private stateOf(projectId: string): ProjectState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = { minutes: new Map() };
      this.projects.set(projectId, state);
    }
    return state;
  }

  /** 按流逝的时间补充令牌，返回补充后的桶（还没写回 state）。 */
  private refill(state: ProjectState, eventsPerMinute: number, now: number): Bucket {
    const capacity = capacityOf(eventsPerMinute);
    const previous = state.bucket;
    if (!previous || previous.eventsPerMinute !== eventsPerMinute) {
      return { tokens: capacity, updatedAt: now, eventsPerMinute };
    }
    const elapsed = Math.max(0, now - previous.updatedAt);
    return {
      tokens: Math.min(capacity, previous.tokens + (elapsed * eventsPerMinute) / MINUTE),
      updatedAt: now,
      eventsPerMinute,
    };
  }
}
