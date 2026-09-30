import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';

/**
 * 浏览器上下文采集的无状态辅助函数。除 currentRoute 外都兼容测试或 SSR 中缺少 window 的情况；
 * currentRoute 只在插件安装之后调用，那时一定在浏览器里。
 */
export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** 当前路由：路径加 hash，不含查询参数。 */
export function currentRoute(): string {
  return `${location.pathname}${location.hash}`;
}

export function getPageContext(): MonitorEvent['page'] {
  if (typeof location === 'undefined') return { url: 'unknown://' };
  return {
    url: location.href,
    route: currentRoute(),
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

/** 最多跟到第几层 cause：再往下通常是框架内部的包装，只会让堆栈变长。 */
const MAX_CAUSES = 5;
/** 堆栈里的一帧：以 :行:列 结尾（V8、Firefox、Safari），或者 V8 的「at ...」。 */
const FRAME_LINE = /:\d+:\d+\)?\s*$|^\s*at\s/;

/** 把任意值描述成一行文字：rejection 的 reason、cause 都可能不是 Error。 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 只取堆栈里的帧：V8 的堆栈第一行是「类型: 消息」，cause 段的标题已经写了它。 */
function stackFrames(error: Error): string {
  const lines = (error.stack ?? '').split('\n');
  const first = lines.findIndex((line) => FRAME_LINE.test(line));
  return first === -1 ? '' : lines.slice(first).join('\n');
}

/**
 * 把 cause 链接在堆栈后面：每层一行「Caused by: 类型: 消息」，再接那一层的帧，最多 5 层，遇到循环引用就停。
 * ES2022 的 new Error(message, { cause }) 常用来包装底层错误（请求失败 → 业务层抛出「下单失败」），
 * 只报最外层，真正的根因就丢了。拼成文本而不是另加结构化字段：服务端逐行还原 Source Map、
 * 按栈顶帧生成指纹的逻辑都不用改，指纹仍由最外层错误决定。
 */
function stackWithCauses(error: Error): string | undefined {
  let stack = error.stack;
  const seen = new Set<unknown>([error]);
  try {
    let cause: unknown = (error as { cause?: unknown }).cause;
    for (let depth = 0; depth < MAX_CAUSES && cause != null && !seen.has(cause); depth += 1) {
      seen.add(cause);
      const title = cause instanceof Error ? `${cause.name}: ${cause.message}` : describe(cause);
      const frames = cause instanceof Error ? stackFrames(cause) : '';
      stack = `${stack ?? `${error.name}: ${error.message}`}\nCaused by: ${title}${frames ? `\n${frames}` : ''}`;
      cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
    }
  } catch {
    // cause 是会抛错的 getter 之类的情况：保留已经拼好的部分。captureException 不能把异常抛给业务代码。
  }
  return stack;
}

export function errorPayload(error: unknown): Record<string, unknown> {
  // Promise rejection 的 reason 可以是任意值，统一转换后才能稳定序列化。
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: stackWithCauses(error) };
  }
  if (typeof error === 'string') return { name: 'Error', message: error };
  return { name: 'UnknownError', message: describe(error) };
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
