import { expect, test, type APIRequestContext } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Playwright 端到端测试跨越真实浏览器、SDK、HTTP Server、SQLite 和 Dashboard。 */
interface IssueItem {
  id: string;
  title: string;
  eventCount: number;
}

async function issues(request: APIRequestContext): Promise<IssueItem[]> {
  const response = await request.get(
    'http://127.0.0.1:4318/api/v1/projects/demo-project/issues?page=1&pageSize=25',
  );
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { items: IssueItem[] }).items;
}

function warningCount(items: IssueItem[]): number {
  return items
    .filter((item) => item.title.includes('warehouseId'))
    .reduce((total, item) => total + item.eventCount, 0);
}

test('triage view loads seeded telemetry and preserves filters in the URL', async ({ page }) => {
  await page.goto('/projects/demo-project/issues');
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(
    page.locator('.summary-metrics article').filter({ hasText: 'Events / 24 h' }),
  ).toContainText('207');
  await expect(page.locator('.issue-row')).toHaveCount(10);

  await page.getByLabel('Severity', { exact: true }).selectOption('warning');
  await expect(page).toHaveURL(/level=warning/);
  await expect(page.locator('.issue-row')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('Severity', { exact: true })).toHaveValue('warning');
});

test('advanced filters, global search dialog, and pagination remain URL-driven', async ({
  page,
}) => {
  await page.goto('/projects/demo-project/issues');
  await page.getByLabel('Release', { exact: true }).selectOption('2.3.9');
  await page.getByLabel('Browser', { exact: true }).selectOption('Edge');
  await page.getByLabel('Time window', { exact: true }).selectOption('7d');
  await expect(page).toHaveURL(/release=2.3.9/);
  await expect(page).toHaveURL(/browser=Edge/);
  await expect(page).toHaveURL(/window=7d/);

  const filteredUrl = page.url();
  await page.getByRole('button', { name: /Search evidence/ }).click();
  const searchDialog = page.getByRole('dialog', { name: 'Search evidence' });
  await expect(searchDialog).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search issues' })).toBeFocused();
  expect(page.url()).toBe(filteredUrl);
  await page.getByRole('searchbox', { name: 'Search issues' }).fill('hydrate');
  await expect(searchDialog.getByText('Matching evidence', { exact: true })).toBeVisible();
  await expect(searchDialog.getByRole('link', { name: /Checkout state failed/ })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search issues' }).press('Escape');
  await expect(searchDialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Search evidence' })).toBeFocused();
  await page.keyboard.press('Control+K');
  await expect(searchDialog).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search issues' }).press('Escape');

  await page.goto('/projects/demo-project/issues?pageSize=10');
  await expect(page.locator('.issue-row')).toHaveCount(10);
  await expect(page.locator('.pagination')).toContainText('Showing 1–10 of 16 grouped issues');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.issue-row')).toHaveCount(6);
  await expect(page.locator('.pagination')).toContainText('Showing 11–16 of 16 grouped issues');
  await expect(page.locator('.pagination')).toContainText('2 / 2');

  await page.getByLabel('Issues per page').selectOption('25');
  await expect(page).toHaveURL(/page=1/);
  await expect(page).toHaveURL(/pageSize=25/);
  await expect(page.locator('.issue-row')).toHaveCount(16);
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
});

test('primary dashboard routes stay console-clean and avoid failed API responses', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedApiResponses: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.port === '4318' && response.status() >= 400) {
      failedApiResponses.push(`${response.status()} ${url.pathname}`);
    }
  });

  for (const [path, heading] of [
    ['/projects/demo-project/issues', 'Issues'],
    ['/projects/demo-project/performance', 'Performance'],
    ['/projects/demo-project/releases', 'Releases'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
  }

  await page.goto('/projects/demo-project/issues');
  await page.locator('.issue-row').first().click();
  await expect(page.locator('.issue-heading h1')).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedApiResponses).toEqual([]);
});

test('issue detail reconstructs its breadcrumb evidence chain', async ({ page }) => {
  await page.goto('/projects/demo-project/issues');
  await page.locator('.issue-row').filter({ hasText: '503' }).click();
  await expect(page.locator('.issue-heading h1')).toContainText('503');
  await expect(page.locator('.evidence-chain li')).toHaveCount(4);
  await expect(page.getByText('POST /payment/authorize → 503')).toBeVisible();
});

test('long issue titles do not overflow a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/projects/demo-project/issues');
  await expect(page.getByRole('button', { name: 'Search evidence' })).toBeVisible();
  await page.locator('.issue-row').filter({ hasText: 'Resource failed' }).click();
  await expect(page.locator('.issue-heading h1')).toContainText('address-lookup');

  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
});

test('diagnosis is generated from stored evidence without blocking issue data', async ({
  page,
}) => {
  await page.goto('/projects/demo-project/issues');
  await page.locator('.issue-row').first().click();
  await page.getByRole('button', { name: 'diagnosis' }).click();
  await page.getByRole('button', { name: 'Generate diagnosis' }).click();
  await expect(page.getByRole('heading', { name: 'Evidence cited' })).toBeVisible();
  await expect(page.getByText('local-evidence-engine')).toBeVisible();
  await expect(page.getByText(/read-only hypothesis/i)).toBeVisible();

  const regeneration = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/diagnoses'),
  );
  await page.getByRole('button', { name: 'Regenerate' }).click();
  expect((await regeneration).postDataJSON()).toMatchObject({ force: true });
});

test('source map upload maps a newly ingested browser stack through the API', async ({
  request,
}) => {
  const upload = await request.post(
    'http://127.0.0.1:4318/api/v1/releases/demo-release-2-4-1/source-maps',
    {
      multipart: {
        minifiedFile: 'runtime-smoke.js',
        file: {
          name: 'runtime-smoke.js.map',
          mimeType: 'application/json',
          buffer: Buffer.from(
            JSON.stringify({
              version: 3,
              file: 'runtime-smoke.js',
              sources: ['src/runtime.ts'],
              names: ['mappedSubmit'],
              mappings: 'AAAAA',
            }),
          ),
        },
      },
    },
  );
  expect(upload.status()).toBe(201);
  const sourceMap = (await upload.json()) as { id: string };

  try {
    const ingest = await request.post('http://127.0.0.1:4318/api/v1/envelopes', {
      data: {
        dsnKey: 'demo-dsn-key',
        sentAt: Date.now(),
        events: [
          {
            eventId: 'e2e-source-map-event',
            eventType: 'error',
            timestamp: Date.now(),
            projectId: 'demo-project',
            release: '2.4.1',
            environment: 'production',
            page: { url: 'https://shop.test/runtime', route: '/runtime' },
            device: { userAgent: 'Mozilla/5.0 Chrome/130.0' },
            payload: {
              name: 'TypeError',
              message: 'Source map E2E failure',
              stack:
                'TypeError: Source map E2E failure\n    at a (https://shop.test/assets/runtime-smoke.js:1:1)',
            },
            breadcrumbs: [],
          },
        ],
      },
    });
    expect(ingest.status()).toBe(202);
    const issueId = ((await ingest.json()) as { issueIds: string[] }).issueIds[0]!;
    const detail = await request.get(`http://127.0.0.1:4318/api/v1/issues/${issueId}`);
    expect(detail.status()).toBe(200);
    expect(
      ((await detail.json()) as { sampleEvent: { originalStack: string } }).sampleEvent
        .originalStack,
    ).toContain('at mappedSubmit (src/runtime.ts:1:1)');
  } finally {
    await rm(resolve('apps/server/.tracepilot/source-maps', `${sourceMap.id}.map`), {
      force: true,
    });
  }
});

test('playground SDK sends a captured warning through the real ingest API', async ({
  page,
  request,
}) => {
  const before = warningCount(await issues(request));
  await page.goto('http://127.0.0.1:4174');
  await expect(page.getByText('SDK armed')).toBeVisible();
  await page.getByRole('button', { name: /Captured warning/ }).click();
  await page.getByRole('button', { name: 'Flush event buffer' }).click();
  await expect.poll(async () => warningCount(await issues(request))).toBeGreaterThan(before);
});
