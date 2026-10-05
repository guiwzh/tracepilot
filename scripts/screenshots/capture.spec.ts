import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  // 6. 修复简报：把调查整理成交给编码 Agent 的 Markdown，TracePilot 自己不改代码。
  const brief = page.locator('.fix-brief');
  await brief.getByRole('button', { name: 'Prepare fix brief' }).click();
  await expect(brief.locator('.fix-brief-markdown')).toContainText('# Fix brief');
  await brief.scrollIntoViewIfNeeded();
  await brief.screenshot({ path: resolve(outputDir, '08-fix-brief.png') });
});

test('capture backend traces on failed requests', async ({ page }) => {
  // 7. Network 标签：每个请求带着它在后端链路里的 trace（SDK 加的 W3C traceparent）。
  await page.goto('/projects/demo-project/issues?search=payment%2Fauthorize');
  await page.locator('.issue-row').first().click();
  await expect(page.locator('.issue-trace')).toBeVisible();
  await page.locator('.detail-tabs button', { hasText: 'network' }).click();
  await expect(page.locator('.network-list .trace-link').first()).toBeVisible();
  await page.screenshot({ path: resolve(outputDir, '10-network-trace.png') });
});

test('capture alerts with an automatic investigation', async ({ page, request }) => {
  // 8. 告警：新 Issue 通知到一个本机起的签名 Webhook，并顺带发起调查；调查结束后跟进通知到同一个渠道。
  const received: string[] = [];
  const receiver = createServer((incoming, response) => {
    incoming.on('data', () => {});
    incoming.on('end', () => {
      received.push(incoming.url ?? '');
      response.end('ok');
    });
  });
  await new Promise<void>((done) => receiver.listen(0, '127.0.0.1', done));
  const port = (receiver.address() as AddressInfo).port;
  let ruleId: string | undefined;
  try {
    const created = await request.post(
      'http://127.0.0.1:4318/api/v1/projects/demo-project/alert-rules',
      {
        data: {
          name: 'On-call webhook',
          triggers: ['new_issue', 'regression', 'escalating'],
          autoInvestigate: true,
          channel: { type: 'webhook', url: `http://127.0.0.1:${port}/hook`, secret: 'demo-secret' },
        },
      },
    );
    expect(created.status()).toBe(201);
    ruleId = ((await created.json()) as { id: string }).id;
    const now = Date.now();
    await request.post('http://127.0.0.1:4318/api/v1/envelopes', {
      data: {
        dsnKey: 'demo-dsn-key',
        sentAt: now,
        events: [
          {
            eventId: `screenshot-alert-${now}`,
            eventType: 'error',
            timestamp: now,
            projectId: 'demo-project',
            release: '2.4.1',
            environment: 'production',
            page: { url: 'https://shop.example/checkout/gift-card', route: '/checkout/gift-card' },
            device: { userAgent: 'Mozilla/5.0 Chrome/130.0' },
            payload: { name: 'TypeError', message: 'Gift card balance was not loaded' },
            breadcrumbs: [],
          },
        ],
      },
    });
    // 告警一条、调查结束后的跟进一条。
    await expect.poll(() => received.length, { timeout: 30_000 }).toBe(2);
    await page.goto('/projects/demo-project/settings');
    const alerts = page.locator('.alert-rules');
    await expect(
      alerts.locator('.alert-deliveries li').filter({ hasText: 'Gift card balance' }),
    ).toHaveCount(2);
    await page.addStyleTag({ content: '.topbar { position: static !important; }' });
    await alerts.screenshot({ path: resolve(outputDir, '09-alerts.png') });
  } finally {
    receiver.close();
    // 规则不留在开发库里：下次重新出图时不会叠加。
    if (ruleId) await request.delete(`http://127.0.0.1:4318/api/v1/alert-rules/${ruleId}`);
  }
});

test('capture the performance view', async ({ page }) => {
  // 9. Web Vitals 页的首屏：各指标的分位数与评级、分位数对比图；按维度的对比与趋势在下方。
  await page.goto('/projects/demo-project/performance');
  await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
  await expect(page.locator('.vital-card').first()).toBeVisible();
  // 性能页的图表用 ECharts 默认的 1 秒入场动画（cubicInOut），0.9 秒时已基本画完。
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(outputDir, '05-performance.png') });
});

test('capture the incident playground', async ({ page }) => {
  // 10. 演练场：可控地制造运行时错误、Promise、资源、请求、业务码失败、路由、React 渲染错误、白屏等信号。
  await page.goto('http://127.0.0.1:4174/');
  await expect(page.locator('body')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(outputDir, '06-playground.png') });
});
