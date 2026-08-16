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
  await expect(page.locator('.issue-row')).toHaveCount(4);

  await page.getByLabel('Severity', { exact: true }).selectOption('warning');
  await expect(page).toHaveURL(/level=warning/);
  await expect(page.locator('.issue-row')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('Severity', { exact: true })).toHaveValue('warning');
});

test('advanced filters, global search, and pagination remain URL-driven', async ({ page }) => {
  await page.goto('/projects/demo-project/issues');
  await page.getByLabel('Release', { exact: true }).selectOption('2.3.9');
  await page.getByLabel('Browser', { exact: true }).selectOption('Edge');
  await page.getByLabel('Time window', { exact: true }).selectOption('7d');
  await expect(page).toHaveURL(/release=2.3.9/);
  await expect(page).toHaveURL(/browser=Edge/);
  await expect(page).toHaveURL(/window=7d/);

  await page.getByRole('button', { name: /Search evidence/ }).click();
  await expect(page.getByPlaceholder('Search title or fingerprint')).toBeFocused();

  await page.goto('/projects/demo-project/issues?pageSize=1');
  await page.locator('.pagination button').last().click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.pagination')).toContainText('2 / 4');
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
