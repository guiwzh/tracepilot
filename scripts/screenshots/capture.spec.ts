import { expect, test, type APIRequestContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SourceMapGenerator } from 'source-map';

/**
 * 生成 README 用的截图。跑 `pnpm screenshots` 即可重新出图，
 * 因此文档里的画面和当前代码始终对得上，不会停留在某次手工截屏。
 *
 * 数据来自 globalSetup 重建的虚构种子，不含真实公司或用户信息。
 */
const outputDir = resolve('docs/screenshots');
const API = 'http://127.0.0.1:4318';

/**
 * 种子数据不带 Source Map，堆栈页默认只有压缩栈。
 * 这里按种子堆栈的真实坐标造一份 map 并上传，让截图能展示还原前后的对比——
 * 上传会触发该 Release 全部历史事件回填，走的是与生产相同的符号化路径。
 * map 按 Release 隔离，因此每个 Release 都要单独上传一次。
 *
 * 种子堆栈：at calculateTotal (…/checkout.a81e93bd.js:1:420)
 *           at submitOrder   (…/checkout.a81e93bd.js:1:612)
 * 浏览器列号是 1 基，SourceMapGenerator 是 0 基，所以这里减 1。
 */
async function uploadSeedSourceMap(request: APIRequestContext, releaseId: string): Promise<void> {
  const generator = new SourceMapGenerator({ file: 'checkout.a81e93bd.js' });
  generator.addMapping({
    generated: { line: 1, column: 419 },
    original: { line: 84, column: 22 },
    source: 'src/checkout/total.ts',
    name: 'calculateTotal',
  });
  generator.addMapping({
    generated: { line: 1, column: 611 },
    original: { line: 141, column: 8 },
    source: 'src/checkout/submit.ts',
    name: 'submitOrder',
  });

  const response = await request.post(`${API}/api/v1/releases/${releaseId}/source-maps`, {
    multipart: {
      minifiedFile: 'checkout.a81e93bd.js',
      file: {
        name: 'checkout.a81e93bd.js.map',
        mimeType: 'application/json',
        buffer: Buffer.from(generator.toString()),
      },
    },
  });
  expect(response.status()).toBe(201);
}

test.beforeAll(async () => {
  await mkdir(outputDir, { recursive: true });
});

test('capture the investigation walkthrough', async ({ page, request }) => {
  // Source Map 按 Release 隔离，所以两个 Release 都要各传一份——
  // 种子里这两个版本恰好发布了同一个 chunk，Issue 详情展示的是最新事件（2.4.1）。
  await uploadSeedSourceMap(request, 'demo-release-2-4-1');
  await uploadSeedSourceMap(request, 'demo-release-2-3-9');

  // 1. Issue 列表：筛选、趋势、影响用户——排障的入口。
  await page.goto('/projects/demo-project/issues');
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(page.locator('.issue-row').first()).toBeVisible();
  // 等待 Sparkline 的 canvas 画完，否则截图会拍到空白图表。
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

  // 4. 诊断报告：证据约束下的只读结论，含置信度、缺失信息与免责声明。
  await tab('diagnosis').click();
  await page.getByRole('button', { name: 'Generate diagnosis' }).click();
  await expect(page.getByRole('heading', { name: 'Evidence cited' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(outputDir, '04-diagnosis.png'), fullPage: true });
});

test('capture the performance view', async ({ page }) => {
  // 5. Web Vitals：分位数、按 Release/路由/浏览器的对比与趋势。
  await page.goto('/projects/demo-project/performance');
  await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
  await expect(page.locator('.vital-card').first()).toBeVisible();
  // ECharts 有 400ms 入场动画，等它结束再拍。
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(outputDir, '05-performance.png') });
});

test('capture the incident playground', async ({ page }) => {
  // 6. 演练场：可控地制造 runtime / Promise / 资源 / Fetch / XHR / 路由信号。
  await page.goto('http://127.0.0.1:4174/');
  await expect(page.locator('body')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(outputDir, '06-playground.png') });
});
