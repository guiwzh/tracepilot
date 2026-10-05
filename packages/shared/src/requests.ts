/**
 * 一条请求记录（SDK 网络面包屑的 data）在证据里算不算失败：HTTP 4xx / 5xx、拿不到响应的网络错误、
 * 业务码表示失败的 2xx。被取消的请求和 no-cors 的 opaque 响应不算。
 *
 * 这和 SDK 决定「哪些请求单独成为事件」的规则不同：4xx 默认只记面包屑、不成为 Issue，但排查一个错误时，
 * 它之前的 401、404 仍是值得一看的证据。排障 Agent 与单次诊断挑失败请求、工作台 Network 标签的标红都用它。
 * 这个模块不依赖 zod，工作台引入它不会把 zod 打进前端包。
 */
export function isFailedRequest(data: Record<string, unknown> | undefined): boolean {
  if (!data || data.aborted === true) return false;
  if (data.businessCode !== undefined) return true;
  const status = Number(data.status);
  // 状态码 0 是拿不到响应（断网、跨域被拦、超时）；opaque 响应的状态码也是 0，但 SDK 把它记为成功。
  return status >= 400 || (status === 0 && data.success === false);
}
