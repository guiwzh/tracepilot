import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 生成 README 用的截图。跑 `pnpm screenshots` 即可重新出图，
 * 因此文档里的画面和当前代码始终对得上，不会停留在某次手工截屏。
 *
 * 数据来自 globalSetup 重建的虚构种子，不含真实公司或用户信息。
 */
const outputDir = resolve('docs/screenshots');

test.beforeAll(async () => {
  await mkdir(outputDir, { recursive: true });
});

test('capture the investigation walkthrough', async ({ page }) => {
  // 种子已为两个版本上传内联源码的 Source Map，并建好演示 git 仓库，截图直接使用。
  // 1. Issue 列表：筛选、趋势、影响用户——排障的入口。
  await page.goto('/projects/demo-project/issues');
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(page.locator('.issue-row').first()).toBeVisible();
  // 等概览趋势图（ECharts，canvas）的入场动画结束，否则会拍到画了一半的图表；Sparkline 是 SVG，不用等。
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(outputDir, '01-issues.png') });

  // 打开既有堆栈又有证据链的那个 Issue：种子里事件量最大的运行时错误。
  // 列表默认每页 10 条而种子有 16 个 Issue，直接点会因为它不在首页而找不到，
  // 所以用搜索参数直达——筛选条件本来就是 URL 驱动的。
  await page.goto('/projects/demo-project/issues?search=Cannot+read+properties');
  await page.locator('.issue-row').first().click();
  await expect(page.locator('.issue-heading h1')).toContainText('total');
  // 限定在 tab 栏内：概览页里也有跳转按钮，不加范围会命中多个元素。
  const tab = (name: string) => page.locator('.detail-tabs button', { hasText: name });

  // 2. 证据链：把一次事故还原成有时序的用户行为 + 网络 + 错误。
  const chain = page.locator('.evidence-chain');
  await expect(chain.locator('li').first()).toBeVisible();
  await chain.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(outputDir, '02-evidence-chain.png') });

  // 3. 源码堆栈：上方是 Source Map 还原后的原始文件行列，下方是浏览器上报的压缩栈。
  await tab('stack').click();
  await expect(page.locator('.detail-tabs button.active')).toHaveText(/stack/);
  await expect(page.getByText('src/checkout/total.ts')).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(outputDir, '03-stack.png') });

  // 4. 排障 Agent：过程流式可见。刚开始几步时拍一张视口截图，能看到 Live 状态与流式光标。
  await tab('investigation').click();
  await page.getByRole('button', { name: 'Start investigation' }).click();
  await expect(page.locator('.tool-call.is-ok').nth(3)).toBeVisible();
  await page.locator('.investigation-header').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(outputDir, '07-investigation-live.png') });

  // 5. 报告：每条证据带逐字引用和核验结果，可跳回产生它的工具调用。
  await expect(page.getByRole('heading', { name: 'Evidence cited' })).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole('button', { name: /^Open T\d+/ })
    .nth(1)
    .click();
  await page.waitForTimeout(400);
  // 只拍调查面板本身：整页截图时，高度为一屏的吸顶侧栏会在长页面中间断掉；
  // 截长元素时 Playwright 会滚动拼接，吸顶的顶栏也要先取消吸顶，否则会被拼进画面中间。
  await page.addStyleTag({ content: '.topbar { position: static !important; }' });
  await page.locator('.investigation').screenshot({
    path: resolve(outputDir, '04-investigation.png'),
  });
});

test('capture the performance view', async ({ page }) => {
  // 6. Web Vitals 页的首屏：各指标的分位数与评级、分位数对比图；按维度的对比与趋势在下方。
  await page.goto('/projects/demo-project/performance');
  await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
  await expect(page.locator('.vital-card').first()).toBeVisible();
  // ECharts 有 400ms 入场动画，等它结束再拍。
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(outputDir, '05-performance.png') });
});

test('capture the incident playground', async ({ page }) => {
  // 7. 演练场：可控地制造运行时错误、Promise、资源、请求、业务码失败、路由、React 渲染错误、白屏等信号。
  await page.goto('http://127.0.0.1:4174/');
  await expect(page.locator('body')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(outputDir, '06-playground.png') });
});
