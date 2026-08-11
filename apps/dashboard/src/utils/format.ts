// 使用 Intl 而不是手写字符串，浏览器会处理千位分隔、相对时间和本地时区。
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: value > 9_999 ? 'compact' : 'standard' }).format(
    value,
  );
}

export function relativeTime(value: number): string {
  const seconds = Math.round((value - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

export function absoluteTime(value: number): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

export function metricValue(metric: string, value: number): string {
  // CLS 是无单位比例，其余 Web Vital 在本项目中都以毫秒存储。
  if (metric === 'CLS') return value.toFixed(3);
  return `${Math.round(value)} ms`;
}
