/**
 * 后端链路系统里这个 trace 的地址：VITE_TRACE_URL_TEMPLATE 里的 {traceId}、{spanId} 换成实际的值，
 * 例如 Jaeger 的 http://localhost:16686/trace/{traceId}。没有配置时为 null，只显示 id 供复制。
 */
export function traceUrl(
  traceId: string,
  spanId?: string,
  template = import.meta.env.VITE_TRACE_URL_TEMPLATE,
): string | null {
  if (!template) return null;
  return template
    .replaceAll('{traceId}', encodeURIComponent(traceId))
    .replaceAll('{spanId}', encodeURIComponent(spanId ?? ''));
}
