const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const URL_VALUE_KEY =
  /^(?:url|uri|href|referrer|location|route|endpoint|request[-_]?url|response[-_]?url|page[-_]?url|callback[-_]?url|redirect[-_]?url|source[-_]?url|target[-_]?url)$/i;

export function stripUrlQuery(value: string): string {
  try {
    const url = new URL(value, 'http://tracepilot.local');
    url.search = '';
    url.hash = '';
    return url.origin === 'http://tracepilot.local' ? `${url.pathname}` : url.toString();
  } catch {
    return value.replace(/[?#].*$/, '');
  }
}

export function stripUrlQueriesInText(value: string): string {
  return value
    .replace(/(?:https?:\/\/|\/\/)[^\s<>"']*[?#][^\s<>"']*/gi, (url) => url.replace(/[?#].*$/, ''))
    .replace(/(^|[\s(→=])((?:\/|\.\.?\/)[^\s<>"']*[?#][^\s<>"']*)/g, (_match, prefix, url) => {
      return `${String(prefix)}${String(url).replace(/[?#].*$/, '')}`;
    });
}

export function redactSensitive<T>(value: T, depth = 0): T {
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
