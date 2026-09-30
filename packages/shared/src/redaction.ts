/**
 * 脱敏：遮蔽令牌、密码等敏感字段，删除 URL 里的查询参数。
 * 同一套规则用在三处：SDK 在事件离开页面之前，服务端入库时（把客户端数据视为不可信，再做一遍），
 * 以及发给模型之前。
 */
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const URL_VALUE_KEY =
  /^(?:url|uri|href|referrer|location|route|endpoint|request[-_]?url|response[-_]?url|page[-_]?url|callback[-_]?url|redirect[-_]?url|source[-_]?url|target[-_]?url)$/i;

/** 键名是否像令牌、密码、Cookie 这类敏感字段；这类键的值一律遮蔽。 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function stripUrlQuery(value: string): string {
  try {
    // 第二个参数让 /checkout 这类相对 URL 也能由 URL 类解析。
    const url = new URL(value, 'http://tracepilot.local');
    url.search = '';
    url.hash = '';
    return url.origin === 'http://tracepilot.local' ? `${url.pathname}` : url.toString();
  } catch {
    // 非标准 URL 无法解析时，仍尽力删除 ?query 和 #fragment。
    return value.replace(/[?#].*$/, '');
  }
}

export function stripUrlQueriesInText(value: string): string {
  // 错误消息和 Breadcrumb 往往把 URL 嵌在一段文本里，所以不能只处理“值本身就是 URL”的情况。
  return value
    .replace(/(?:https?:\/\/|\/\/)[^\s<>"']*[?#][^\s<>"']*/gi, (url) => url.replace(/[?#].*$/, ''))
    .replace(/(^|[\s(→=])((?:\/|\.\.?\/)[^\s<>"']*[?#][^\s<>"']*)/g, (_match, prefix, url) => {
      return `${String(prefix)}${String(url).replace(/[?#].*$/, '')}`;
    });
}

export function redactSensitive<T>(value: T, depth = 0): T {
  // 限制递归深度：恶意构造的超深嵌套对象可能让递归栈溢出，或拖慢请求处理。
  if (depth > 8) return '[Max depth]' as T;
  if (typeof value === 'string') {
    const cleaned = stripUrlQueriesInText(value)
      .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
    return cleaned as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1)) as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // 敏感键直接遮蔽；URL 字段保留路径用于聚合，但删除可能含身份信息的查询参数。
      if (isSensitiveKey(key)) {
        result[key] = '[REDACTED]';
      } else if (URL_VALUE_KEY.test(key) && typeof item === 'string') {
        result[key] = stripUrlQuery(redactSensitive(item, depth + 1));
      } else {
        result[key] = redactSensitive(item, depth + 1);
      }
    }
    return result as T;
  }
  return value;
}

/** 以 :行:列 结尾的一行是栈帧（V8 的 "at fn (url:1:2)"，Firefox / Safari 的 "fn@url:1:2"）。 */
const FRAME_LOCATION = /:\d+:\d+\)?\s*$/;
/** 栈帧里夹在文件名和 :行:列 之间的查询参数或片段，例如 app.js?v=3:1:420 里的 ?v=3。 */
const FRAME_QUERY = /[?#][^\s()]*?(?=:\d+:\d+)/g;

/**
 * 脱敏一段堆栈。不能直接套用通用的文本规则：它会把 "app.js?v=3:1:420)" 从问号起整段删掉，
 * 行列号一起丢失，服务端就再也无法用 Source Map 还原这一帧。
 * 所以栈帧只删查询参数、保留行列号；其余行（第一行的错误消息等）按普通文本处理。
 */
export function redactStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) =>
      FRAME_LOCATION.test(line) ? line.replace(FRAME_QUERY, '') : redactSensitive(line),
    )
    .join('\n');
}

/** 形状像堆栈、要按栈帧规则处理的字段。componentStack 来自 React 的错误回调。 */
const STACK_KEYS = ['stack', 'componentStack'] as const;

/** 脱敏一个事件 payload：堆栈字段按 redactStack 处理，其余字段按通用规则。 */
export function redactPayload<T extends Record<string, unknown>>(payload: T): T {
  const rest: Record<string, unknown> = { ...payload };
  for (const key of STACK_KEYS) delete rest[key];
  const result = redactSensitive(rest);
  for (const key of STACK_KEYS) {
    if (!(key in payload)) continue;
    const value = payload[key];
    result[key] = typeof value === 'string' ? redactStack(value) : redactSensitive(value);
  }
  return result as T;
}
