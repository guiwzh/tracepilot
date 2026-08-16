/** 数据库 JSON 列的容错解析；旧数据损坏时查询接口仍返回可用降级值。 */
export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  // 使用 nearest-rank：先排序，再向上取分位位置，适合当前小样本本地统计。
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}
