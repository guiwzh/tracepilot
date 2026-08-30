import { expect, test } from '@playwright/test';

/**
 * 回归测试：ECharts 实例的生命周期与数据更新已拆分为两个 effect。
 * option 引用变化时只应调用 setOption，不应 dispose + init 重建整个实例。
 * 判据是容器内的 canvas 节点是否保持同一个引用——重建会产生新的 canvas。
 */
test('chart instances are reused across option changes instead of being rebuilt', async ({
  page,
}) => {
  await page.goto('/projects/demo-project/performance');
  const canvas = page.locator('.trend-chart canvas').first();
  await expect(canvas).toBeVisible();

  await page.evaluate(() => {
    const element = document.querySelector('.trend-chart canvas');
    (window as unknown as { __chartCanvas: Element | null }).__chartCanvas = element;
  });

  // 切换指标会让 trendOption 的 useMemo 重新求值，产生新的 option 引用。
  for (const metric of ['INP', 'CLS', 'FCP', 'TTFB']) {
    await page.selectOption('.metric-picker select', metric);
    await expect(page.getByRole('heading', { name: `${metric} p75 trend` })).toBeVisible();
  }

  const preserved = await page.evaluate(() => {
    const element = document.querySelector('.trend-chart canvas');
    return element === (window as unknown as { __chartCanvas: Element | null }).__chartCanvas;
  });
  expect(preserved).toBe(true);
});
