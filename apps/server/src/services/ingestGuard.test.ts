import { describe, expect, it } from 'vitest';
import { IngestGuard, SPIKE_FLOOR_PER_MINUTE } from './ingestGuard';

const MINUTE = 60_000;
/** 一个整分钟的开头，避免测试跨分钟边界。 */
const T0 = 1_000 * MINUTE;
const LIMITED = { eventsPerMinute: 600, spikeProtection: false };
const SPIKE_ONLY = { eventsPerMinute: 0, spikeProtection: true };

describe('IngestGuard rate limit', () => {
  it('allows a burst up to the bucket and then asks the SDK to wait', () => {
    const guard = new IngestGuard();
    // 每分钟 600 个 → 每秒补 10 个，最多攒 100 个（至少放得下一个满信封）。
    expect(guard.admit('p', 100, LIMITED, T0)).toEqual({ ok: true });
    expect(guard.admit('p', 20, LIMITED, T0)).toEqual({
      ok: false,
      reason: 'project-rate-limit',
      retryAfterSeconds: 2,
    });
    // 两秒补回 20 个。
    expect(guard.admit('p', 20, LIMITED, T0 + 2_000)).toEqual({ ok: true });
    expect(guard.admit('p', 1, LIMITED, T0 + 2_000).ok).toBe(false);
  });

  it('keeps projects apart and treats 0 as unlimited', () => {
    const guard = new IngestGuard();
    expect(guard.admit('a', 100, LIMITED, T0).ok).toBe(true);
    expect(guard.admit('a', 1, LIMITED, T0).ok).toBe(false);
    expect(guard.admit('b', 100, LIMITED, T0).ok).toBe(true);
    const unlimited = { eventsPerMinute: 0, spikeProtection: false };
    for (let index = 0; index < 50; index += 1) {
      expect(guard.admit('c', 100, unlimited, T0).ok).toBe(true);
    }
  });

  it('starts a fresh bucket when the project limit changes', () => {
    const guard = new IngestGuard();
    expect(guard.admit('p', 100, LIMITED, T0).ok).toBe(true);
    expect(guard.admit('p', 100, { ...LIMITED, eventsPerMinute: 6_000 }, T0).ok).toBe(true);
  });
});

describe('IngestGuard spike protection', () => {
  it('caps a quiet project at the floor until the minute ends', () => {
    const guard = new IngestGuard();
    for (let sent = 0; sent < SPIKE_FLOOR_PER_MINUTE; sent += 100) {
      expect(guard.admit('p', 100, SPIKE_ONLY, T0 + 1_000).ok).toBe(true);
    }
    expect(guard.admit('p', 1, SPIKE_ONLY, T0 + 15_500)).toEqual({
      ok: false,
      reason: 'spike-protection',
      // 到下一分钟开始还有 44.5 秒。
      retryAfterSeconds: 45,
    });
    expect(guard.admit('p', 100, SPIKE_ONLY, T0 + MINUTE).ok).toBe(true);
  });

  it('raises the threshold for a project whose normal volume is high', () => {
    const guard = new IngestGuard();
    // 过去一小时每分钟 300 个：阈值是 300 × 10 = 3,000，远高于下限。
    for (let minute = 0; minute < 60; minute += 1) {
      for (let sent = 0; sent < 300; sent += 100) {
        expect(guard.admit('p', 100, SPIKE_ONLY, T0 + minute * MINUTE).ok).toBe(true);
      }
    }
    const now = T0 + 60 * MINUTE;
    for (let sent = 0; sent < 3_000; sent += 100) {
      expect(guard.admit('p', 100, SPIKE_ONLY, now).ok).toBe(true);
    }
    expect(guard.admit('p', 100, SPIKE_ONLY, now).ok).toBe(false);
  });

  it('does not take tokens for a batch that spike protection rejects', () => {
    const guard = new IngestGuard();
    const both = { eventsPerMinute: 60_000, spikeProtection: true };
    for (let sent = 0; sent < SPIKE_FLOOR_PER_MINUTE; sent += 100) {
      expect(guard.admit('p', 100, both, T0).ok).toBe(true);
    }
    // 桶有 10,000 个令牌；被突增保护拒收的 100 个不能从桶里扣掉。
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(guard.admit('p', 100, both, T0).ok).toBe(false);
    }
    // 下一分钟，桶里还剩 10,000 - 600 再补满，至少能收 600 个（突增下限）。
    for (let sent = 0; sent < SPIKE_FLOOR_PER_MINUTE; sent += 100) {
      expect(guard.admit('p', 100, both, T0 + MINUTE).ok).toBe(true);
    }
  });
});
