import { isFailedRequest } from '@trace-pilot/shared';

/**
 * 证据里算作失败的请求，与排障 Agent、单次诊断是同一条规则（shared 的 isFailedRequest）：HTTP 4xx / 5xx、
 * 拿不到响应的网络错误、业务码表示失败的 2xx；被取消的请求和 no-cors 的 opaque 响应不算。
 * 它所在的模块不依赖 zod，引入它不会把 zod 打进前端包（见 packages/shared/src/index.ts）。
 */
export { isFailedRequest };

/**
 * Network 标签里一条请求的结果：状态码；被取消、拿不到响应、业务码失败另外写明。
 * 只写 HTTP 0 看不出是断网还是被取消，只写 HTTP 200 又看不出业务上失败了。
 */
export function requestOutcome(data: Record<string, unknown> | undefined): string {
  if (data?.aborted === true) return 'aborted';
  if (Number(data?.status) === 0 && isFailedRequest(data)) {
    return `network error${data?.error ? `: ${String(data.error)}` : ''}`;
  }
  const business =
    data?.businessCode === undefined
      ? ''
      : ` · code ${String(data.businessCode)}${data.businessMessage ? `: ${String(data.businessMessage)}` : ''}`;
  return `HTTP ${String(data?.status ?? 'unknown')}${business}`;
}
