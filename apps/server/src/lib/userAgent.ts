/**
 * 由 User-Agent 判断浏览器，只分五类。顺序有讲究：Edge 的 UA 里同时有 Chrome/ 和 Safari/，
 * Chrome 的 UA 里有 Safari/，所以先认 Edge，再认 Chrome，最后才是 Safari。
 * iOS 上的所有浏览器都用 WebKit 内核，UA 里没有 Chrome/ 或 Firefox/，归为 Safari。
 *
 * 服务端只有这一份规则。它同时注册成 SQLite 函数 browser_name()（见 db/client.ts），
 * Issue 列表的浏览器筛选和详情页的浏览器分布都在 SQL 里调用它。曾经同一条规则写了四份
 * （两段 JS、一段 SQL CASE、一组 SQL LIKE），改了其中一处，就会出现分布图里看得到、
 * 按它筛选却筛不出来的情况。
 */
export type BrowserName = 'Edge' | 'Chrome' | 'Firefox' | 'Safari' | 'Other';

export function browserName(userAgent: string): BrowserName {
  if (userAgent.includes('Edg/')) return 'Edge';
  if (userAgent.includes('Chrome/')) return 'Chrome';
  if (userAgent.includes('Firefox/')) return 'Firefox';
  if (userAgent.includes('Safari/')) return 'Safari';
  return 'Other';
}
