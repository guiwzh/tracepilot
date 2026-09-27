/**
 * 解析数据库里 JSON 文本列的内容。解析失败（例如数据被手动改坏）时返回 fallback，
 * 让查询接口仍能返回其余字段，而不是整个请求 500。
 */
export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * 计算分位数，quantile 取 0～1，例如 0.75 表示 P75：有 75% 的样本小于等于这个值。
 * Web Vitals 按 P75 评估一个页面的体验，比平均值更不容易被个别极端样本带偏。
 */
export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  // nearest-rank 算法：排序后取第 ceil(q × n) 个样本，结果一定是真实出现过的某个值。
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}
