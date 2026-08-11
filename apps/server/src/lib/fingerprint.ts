import { createHash } from 'node:crypto';
import { stripUrlQuery, type MonitorEvent } from '@trace-pilot/shared';

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
  return input
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/\b(?:1[6-9]|2\d)\d{11}\b/g, '{timestamp}')
    .replace(/\b\d{4,}\b/g, '{id}')
    .replace(/\s+/g, ' ')
    .trim();
}

export function topStackFrame(stack?: string): string {
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
  return createHash('sha256')
    .update(`${normalizeMessage(kind)}|${normalizeMessage(message)}|${topStackFrame(stack)}`)
    .digest('hex');
}
