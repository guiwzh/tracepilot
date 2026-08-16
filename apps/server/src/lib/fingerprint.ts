import { createHash } from 'node:crypto';
import { stripUrlQuery, type MonitorEvent } from '@trace-pilot/shared';

/**
 * 指纹必须忽略 UUID、时间戳、业务 ID 和构建 hash 等动态部分，
 * 否则同一根因的每次发生都会被拆成新的 Issue。
 */
export function normalizeMessage(input: string): string {
  return input
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid')
    .replace(/\b(?:1[6-9]|2\d)\d{11}\b/g, ':timestamp')
    .replace(/\b\d{4,}\b/g, ':id')
    .replace(/([.-])[a-f0-9]{8,}(?=\.(?:js|mjs|css)|\b)/gi, '$1:hash')
    .replace(/https?:\/\/[^\s)]+/g, (url) => stripUrlQuery(url))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeDisplayTitle(input: string): string {
  // 展示标题保留大小写和可读占位符；指纹归一化则会全部转为小写。
  return input
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/\b(?:1[6-9]|2\d)\d{11}\b/g, '{timestamp}')
    .replace(/\b\d{4,}\b/g, '{id}')
    .replace(/\s+/g, ' ')
    .trim();
}

export function topStackFrame(stack?: string): string {
  // 首个包含文件位置的 frame 通常最接近业务根因，比完整堆栈更适合参与稳定指纹。
  if (!stack) return 'no-stack';
  const line = stack
    .split('\n')
    .map((item) => item.trim())
    .find((item) => /(?:https?:\/\/|\/|\w+\.js):?\d*/.test(item));
  return normalizeMessage(line ?? stack.split('\n')[0] ?? 'no-stack');
}

export function eventFingerprint(event: MonitorEvent): string {
  const payload = event.payload;
  const kind = String(payload.name ?? payload.errorType ?? event.eventType);
  const message = String(payload.message ?? payload.url ?? payload.metric ?? 'unknown');
  const stack = typeof payload.stack === 'string' ? payload.stack : undefined;
  // 数据库只保存摘要作为聚合键，不依赖可碰撞的短字符串。
  return createHash('sha256')
    .update(`${normalizeMessage(kind)}|${normalizeMessage(message)}|${topStackFrame(stack)}`)
    .digest('hex');
}
