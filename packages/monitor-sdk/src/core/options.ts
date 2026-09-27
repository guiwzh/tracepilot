import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_DEDUPE_WINDOW,
  DEFAULT_FLUSH_INTERVAL,
  DEFAULT_MAX_QUEUE_SIZE,
  DEFAULT_MAX_RETRIES,
} from '@trace-pilot/shared';
import type { MonitorOptions, ResolvedMonitorOptions } from '../types';

/**
 * 数字配置的默认值和上下界只在这里定义一次，MonitorCore 与 Transport 共用。
 * 两处各写一份时，改了 shared 的默认值却不生效：核心总是把自己写死的值传给传输层。
 */
const LIMITS = {
  batchSize: { fallback: DEFAULT_BATCH_SIZE, minimum: 1, maximum: 100 },
  flushInterval: { fallback: DEFAULT_FLUSH_INTERVAL, minimum: 100, maximum: 86_400_000 },
  maxRetries: { fallback: DEFAULT_MAX_RETRIES, minimum: 0, maximum: 10 },
  maxQueueSize: { fallback: DEFAULT_MAX_QUEUE_SIZE, minimum: 10, maximum: 10_000 },
  dedupeWindow: { fallback: DEFAULT_DEDUPE_WINDOW, minimum: 0, maximum: 600_000 },
} as const;

/** 把外部传入的数字夹进安全范围并取整；缺省或非法（NaN、Infinity）时用默认值。 */
export function clampOption(name: keyof typeof LIMITS, value: number | undefined): number {
  const { fallback, minimum, maximum } = LIMITS[name];
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.floor(Math.max(minimum, Math.min(maximum, value)));
}

/** 所有外部数字配置都在边界处夹紧，避免 0 批量、无限重试等配置让 SDK 失控。 */
export function resolveOptions(options: MonitorOptions): ResolvedMonitorOptions {
  const sampleRate = options.sampleRate;
  return {
    ...options,
    sampleRate:
      sampleRate === undefined || !Number.isFinite(sampleRate)
        ? 1
        : Math.max(0, Math.min(1, sampleRate)),
    batchSize: clampOption('batchSize', options.batchSize),
    flushInterval: clampOption('flushInterval', options.flushInterval),
    maxRetries: clampOption('maxRetries', options.maxRetries),
    maxQueueSize: clampOption('maxQueueSize', options.maxQueueSize),
    dedupeWindow: clampOption('dedupeWindow', options.dedupeWindow),
  };
}
