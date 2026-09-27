/**
 * 脱敏：遮蔽令牌、密码等敏感字段，删除 URL 里的查询参数。
 * SDK 默认不脱敏，接入方可以在 beforeSend 钩子里自行清理；服务端把客户端数据视为不可信，
 * 入库时和发给模型前都会调用这里的函数。
 */
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const URL_VALUE_KEY =
  /^(?:url|uri|href|referrer|location|route|endpoint|request[-_]?url|response[-_]?url|page[-_]?url|callback[-_]?url|redirect[-_]?url|source[-_]?url|target[-_]?url)$/i;

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
      if (SENSITIVE_KEY.test(key)) {
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
