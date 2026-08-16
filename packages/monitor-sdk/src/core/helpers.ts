import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';

/** 浏览器上下文采集的无状态辅助函数；所有 API 都兼容测试或 SSR 中缺少 window 的情况。 */
export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function getPageContext(): MonitorEvent['page'] {
  // typeof 检查不会在 Node/SSR 环境中触发 ReferenceError。
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

export function breadcrumbId(breadcrumb: Omit<Breadcrumb, 'id'>): Breadcrumb {
  return { ...breadcrumb, id: createId() };
}
