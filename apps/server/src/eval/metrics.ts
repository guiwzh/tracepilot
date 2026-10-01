/**
 * 重复试验与一致性的统计量。
 *
 * 模型的输出有随机性，同一个用例跑一次答对，不代表每次都答对。只跑一次的准确率回答的是
 * 「这一次运气如何」；线上排障更关心「每次都能答对吗」。
 */

/** 组合数 C(n, k)，k 超出 [0, n] 时为 0。 */
function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= k; index += 1) result = (result * (n - k + index)) / index;
  return result;
}

function checkTrials(n: number, c: number, k: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k)) {
    throw new RangeError('n, c and k must be integers');
  }
  if (n < 1 || c < 0 || c > n || k < 1 || k > n) {
    throw new RangeError(`invalid trials: n=${n}, c=${c}, k=${k}`);
  }
}

/**
 * pass^k：一个用例跑了 n 次、成功 c 次时，「随机取 k 次全部成功」的概率 C(c,k) / C(n,k)
 * （τ-bench 用它衡量可靠性）。k = 1 时就是成功率 c / n；k 越大越苛刻，n = k 时只有全对才是 1。
 */
export function passHatK(n: number, c: number, k: number): number {
  checkTrials(n, c, k);
  return binomial(c, k) / binomial(n, k);
}

/**
 * pass@k：「随机取 k 次至少一次成功」的概率 1 − C(n−c,k) / C(n,k)（HumanEval 的无偏估计）。
 * 衡量「多试几次能不能碰上」，排障场景里只作对照：用户不会把同一个问题让 Agent 查三遍再挑一个。
 */
export function passAtK(n: number, c: number, k: number): number {
  checkTrials(n, c, k);
  return 1 - binomial(n - c, k) / binomial(n, k);
}

export interface Agreement<Label extends string> {
  /** 两个评分者都给了结论的样本数。 */
  n: number;
  /** 结论相同的比例。 */
  observed: number;
  /**
   * Cohen's kappa：扣除「碰巧一致」之后的一致程度，κ = (po − pe) / (1 − pe)。
   * 1 为完全一致，0 相当于随机，负数比随机还差。两个评分者都只用了同一个类别时 pe = 1，κ 没有定义，为 null。
   */
  kappa: number | null;
  /** 混淆矩阵：matrix[a][b] = 评分者 A 给 a、评分者 B 给 b 的样本数。 */
  matrix: Record<Label, Record<Label, number>>;
}

/** 两个评分者（例如 LLM 裁判与人工）对同一批样本的一致性。 */
export function cohenKappa<Label extends string>(
  labels: readonly Label[],
  pairs: ReadonlyArray<readonly [Label, Label]>,
): Agreement<Label> {
  const matrix = Object.fromEntries(
    labels.map((row) => [row, Object.fromEntries(labels.map((column) => [column, 0]))]),
  ) as Record<Label, Record<Label, number>>;
  for (const [a, b] of pairs) {
    if (!labels.includes(a) || !labels.includes(b)) {
      throw new RangeError(`unknown label: ${!labels.includes(a) ? a : b}`);
    }
    matrix[a][b] += 1;
  }
  const n = pairs.length;
  if (n === 0) return { n, observed: 0, kappa: null, matrix };
  const observed = labels.reduce((sum, label) => sum + matrix[label][label], 0) / n;
  const expected = labels.reduce((sum, label) => {
    const rowShare = labels.reduce((total, column) => total + matrix[label][column], 0) / n;
    const columnShare = labels.reduce((total, row) => total + matrix[row][label], 0) / n;
    return sum + rowShare * columnShare;
  }, 0);
  return {
    n,
    observed,
    kappa: expected >= 1 ? null : (observed - expected) / (1 - expected),
    matrix,
  };
}
