import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';

/** 浏览器上下文采集的无状态辅助函数；所有 API 都兼容测试或 SSR 中缺少 window 的情况。 */
export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function getPageContext(): MonitorEvent['page'] {
  if (typeof location === 'undefined') return { url: 'unknown://' };
  return {
    url: location.href,
    route: `${location.pathname}${location.hash}`,
    title: typeof document !== 'undefined' ? document.title : undefined,
    referrer: typeof document !== 'undefined' ? document.referrer : undefined,
  };
}

export function getDeviceContext(): MonitorEvent['device'] {
  return {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    viewport:
      typeof window !== 'undefined'
        ? { width: window.innerWidth, height: window.innerHeight }
        : undefined,
  };
}

export function errorPayload(error: unknown): Record<string, unknown> {
  // Promise rejection 的 reason 可以是任意值，统一转换后才能稳定序列化。
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  if (typeof error === 'string') return { name: 'Error', message: error };
  try {
    return { name: 'UnknownError', message: JSON.stringify(error) };
  } catch {
    return { name: 'UnknownError', message: String(error) };
  }
}

/**
 * 按会话采样：同一标签页会话内要么全采，要么全不采。
 * 按事件采样会让一条错误被采到、而它之前的请求和性能样本没被采到，证据链因此断裂。
 * 决定写进 sessionStorage，刷新页面后保持一致；采样率变化时重新决定。
 */
export function sessionSampled(projectId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const key = `tracepilot:sampled:${projectId}`;
  try {
    const stored = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key);
    const [storedRate, decision] = stored?.split('|') ?? [];
    if (storedRate !== undefined && Number(storedRate) === rate) return decision === '1';
  } catch {
    // 存储不可用时退化为按页面加载采样。
  }
  const decision = Math.random() < rate;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, `${rate}|${decision ? 1 : 0}`);
    }
  } catch {
    // 同上。
  }
  return decision;
}

/**
 * 取异常栈里第一行真正的栈帧，并去掉行列号。
 * V8 的栈首行是 "TypeError: message"，帧形如 "    at fn (url:1:2)"；
 * Firefox / Safari 没有消息行，帧形如 "fn@url:1:2"。按「以 :行:列 结尾」识别帧才能兼容两者。
 */
export function firstFrame(stack: unknown): string {
  const frame = String(stack ?? '')
    .split('\n')
    .find((line) => /:\d+:\d+\)?\s*$/.test(line));
  return (frame ?? '').trim().replace(/:\d+:\d+(?=\)?$)/, ':line:column');
}

export function breadcrumbId(breadcrumb: Omit<Breadcrumb, 'id'>): Breadcrumb {
  return { ...breadcrumb, id: createId() };
}
