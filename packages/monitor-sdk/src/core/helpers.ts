import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';

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
