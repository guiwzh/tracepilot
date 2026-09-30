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
 * 本标签页会话的抽签值：一个 [0, 1) 的随机数，第一次用到时抽出，写进 sessionStorage，刷新页面后沿用。
 * 各项采样决定都由它和采样率比较得出（抽签值小于采样率即被采中）：
 * - 按会话而不是按事件抽签：同一会话要么全采、要么全不采，采到的错误不会缺了它之前的请求和操作；
 * - 存抽签值而不是「采或不采」：调整采样率不必重新抽签，调高只会多采一些会话，原来采到的仍然采到；
 * - 几个采样率共用一个抽签值，上报性能样本的会话一定是被采样会话的子集。
 * sessionStorage 不可用时退化为按页面加载抽签。
 */
export function sessionDraw(projectId: string): number {
  const key = `tracepilot:sampled:${projectId}`;
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key);
    // 旧版本在这里存的是「采样率|0 或 1」，转成数字是 NaN，会重新抽签。
    const stored = raw ? Number(raw) : Number.NaN;
    if (stored >= 0 && stored < 1) return stored;
  } catch {
    // 存储不可用时退化为按页面加载抽签。
  }
  const draw = Math.random();
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, String(draw));
  } catch {
    // 同上。
  }
  return draw;
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
