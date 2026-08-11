const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;

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

export function redactSensitive<T>(value: T, depth = 0): T {
  if (depth > 8) return '[Max depth]' as T;
  if (typeof value === 'string') {
    const cleaned = value
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
      result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(item, depth + 1);
    }
    return result as T;
  }
  return value;
}
