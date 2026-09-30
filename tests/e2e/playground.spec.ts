import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Playground 的每个场景都在真实 Chrome 里点一遍，再核对服务端最终收到了什么。
 *
 * SDK 插件的采集行为（window.error、unhandledrejection、资源、fetch / XHR、路由、React 错误边界）
 * 只有在真实浏览器里才看得清。演练场曾经只能手点；这组测试把它变成了这些插件的回归测试。
 *
 * 每个用例写入一个新建的项目（通过地址参数告诉演练场），不影响其他用例断言的种子数据计数。
 */
const API = 'http://127.0.0.1:4318';
const LAB = 'http://127.0.0.1:4174';

interface Project {
  id: string;
  dsnKey: string;
}

interface IssueSummary {
  id: string;
  title: string;
  level: string;
  eventCount: number;
}

interface StoredEventView {
  pageUrl: string;
  context: { payload: Record<string, unknown> };
  breadcrumbs: Array<{ type: string; message: string }>;
}

async function createProject(request: APIRequestContext): Promise<Project> {
  const response = await request.post(`${API}/api/v1/projects`, {
    data: { name: `Playground ${Date.now()}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as Project;
}

async function openLab(page: Page, project: Project): Promise<void> {
  await page.goto(`${LAB}/?projectId=${project.id}&dsnKey=${project.dsnKey}`);
  await expect(page.getByRole('status')).toContainText('SDK armed');
}

async function trigger(page: Page, scenario: string): Promise<void> {
  await page.locator(`[data-scenario="${scenario}"]`).click();
}

async function flush(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Flush event buffer' }).click();
}

async function issues(request: APIRequestContext, project: Project): Promise<IssueSummary[]> {
  const response = await request.get(`${API}/api/v1/projects/${project.id}/issues?pageSize=100`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { items: IssueSummary[] }).items;
}

/** 等到标题匹配的 Issue 出现，返回它。 */
async function waitForIssue(
  request: APIRequestContext,
  project: Project,
  title: RegExp,
): Promise<IssueSummary> {
  let found: IssueSummary | undefined;
  await expect
    .poll(
      async () => {
        found = (await issues(request, project)).find((issue) => title.test(issue.title));
        return found !== undefined;
      },
      { timeout: 10_000, message: `issue matching ${title}` },
    )
    .toBe(true);
  return found!;
}

async function latestEvent(request: APIRequestContext, issue: IssueSummary) {
  const response = await request.get(`${API}/api/v1/issues/${issue.id}/events?limit=1`);
  return ((await response.json()) as { items: StoredEventView[] }).items[0]!;
}

test('runtime errors, rejections and broken resources become issues', async ({ page, request }) => {
  const project = await createProject(request);
  await openLab(page, project);
  await trigger(page, 'exception');
  await trigger(page, 'promise');
  await trigger(page, 'resource');
  await flush(page);

  // 标题里没有浏览器加的 "Uncaught " 前缀：与 captureException 上报的同一个错误指纹一致。
  await waitForIssue(
    request,
    project,
    /^Cannot read properties of undefined \(reading 'total'\) — order \{timestamp\}$/,
  );
  await waitForIssue(request, project, /^Payment intent \{uuid\} was not initialized$/);
  await waitForIssue(request, project, /^Resource failed: .*\/__lab\/missing-checkout-badge-/);
});

test('failed fetch and XHR requests are reported without their query strings', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await openLab(page, project);
  await trigger(page, 'fetch');
  await trigger(page, 'xhr');
  await flush(page);

  const payment = await waitForIssue(request, project, /^POST \/__lab\/payment → 503$/);
  await waitForIssue(request, project, /^GET \/__lab\/inventory → 503$/);
  // ?token=demo-secret 在离开页面之前就被 SDK 去掉了。
  expect(JSON.stringify(await latestEvent(request, payment))).not.toContain('demo-secret');
});

test('a 200 response whose business code means failure becomes its own issue', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await openLab(page, project);
  await trigger(page, 'business');
  await flush(page);

  // SDK 读克隆的 JSON 响应体，判定函数返回的业务码随事件上报，服务端按业务码单独成为一个 Issue。
  const coupon = await waitForIssue(request, project, /^POST \/__lab\/coupon → code 40012$/);
  expect(await latestEvent(request, coupon)).toMatchObject({
    context: { payload: { status: 200, businessCode: 40012, businessMessage: 'Coupon expired' } },
  });
});

test('route changes and cancelled requests stay breadcrumbs on the next event', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await openLab(page, project);
  await trigger(page, 'route');
  await trigger(page, 'abort');
  // 等请求真正被取消，它的 breadcrumb 才会排在下一个事件之前。
  await page.waitForTimeout(300);
  await trigger(page, 'warning');
  await flush(page);

  const warning = await waitForIssue(request, project, /^Inventory response omitted warehouseId$/);
  expect(warning.level).toBe('warning');
  const event = await latestEvent(request, warning);
  expect(event.breadcrumbs.map((item) => item.message)).toEqual(
    expect.arrayContaining(['pushState → /checkout/review', 'GET /__lab/slow → aborted']),
  );
  // beforeSend 删掉了业务认定的个人信息，其余上下文照常上报。
  expect(event.context.payload).toMatchObject({ cartId: 'cart-8842' });
  expect(event.context.payload).not.toHaveProperty('customerEmail');
  expect(event.pageUrl).toMatch(/\/checkout\/review$/);

  // 路由变化和被取消的请求都不会单独成为 Issue。
  const titles = (await issues(request, project)).map((issue) => issue.title);
  expect(titles).toEqual(['Inventory response omitted warehouseId']);
});

test('a render error caught by an error boundary is reported with its component stack', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await openLab(page, project);
  await trigger(page, 'react');
  await expect(page.getByLabel('Order summary widget')).toContainText('error boundary caught');
  await flush(page);

  const issue = await waitForIssue(
    request,
    project,
    /^Cannot read properties of undefined \(reading 'lineItems'\)$/,
  );
  const { context } = await latestEvent(request, issue);
  expect(context.payload).toMatchObject({ mechanism: 'react' });
  expect(String(context.payload.componentStack)).toContain('CheckoutSummary');
});

test('an error storm sends one event per signature', async ({ page, request }) => {
  const project = await createProject(request);
  await openLab(page, project);
  await trigger(page, 'storm');
  await page.waitForTimeout(500);
  await flush(page);

  const storm = await waitForIssue(request, project, /^Inventory sync failed for warehouse/);
  await waitForIssue(request, project, /\/__lab\/thumbs\/product-\d+\.png$/);
  const all = await issues(request, project);
  // 20 个相同的异常和 12 张只差编号的坏图，各只送出一个事件。
  expect(storm.eventCount).toBe(1);
  expect(all.filter((issue) => issue.title.includes('/__lab/thumbs/'))).toEqual([
    expect.objectContaining({ eventCount: 1 }),
  ]);
});

test('events still queued when the page unloads reach the server', async ({ page, request }) => {
  const project = await createProject(request);
  await openLab(page, project);
  await Promise.all([page.waitForEvent('load'), trigger(page, 'exit')]);

  await waitForIssue(request, project, /^Checkout draft queued before leaving$/);
  await waitForIssue(request, project, /^Address form left half-filled$/);
});

test('the lab reports failed delivery instead of claiming success', async ({ page, request }) => {
  // 回归：服务端不可达时，界面仍显示 "Buffer flushed" 和 "SDK armed"。
  const project = await createProject(request);
  await page.route('**/api/v1/envelopes', (route) => route.abort('connectionrefused'));
  await openLab(page, project);
  await trigger(page, 'warning');
  await flush(page);

  await expect(page.getByRole('status')).toContainText('Delivery failing');
  const problem = page.locator('.activity li[data-kind="problem"]').first();
  await expect(problem).toContainText('still pending');
  await expect(problem).toContainText('server unreachable');
});
