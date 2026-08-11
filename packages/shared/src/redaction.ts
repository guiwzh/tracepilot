/**
 * 遥测数据会离开业务页面，因此脱敏必须是共享的基础能力。
 * SDK 可以先通过 beforeSend 清理，Server 入库和调用模型前还会再次调用这里的函数。
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
  // 限制递归深度既避免恶意超深对象，也防止遥测清理本身拖慢宿主页面。
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
