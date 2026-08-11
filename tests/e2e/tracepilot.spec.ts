import { expect, test, type APIRequestContext } from '@playwright/test';

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

test('issue detail reconstructs its breadcrumb evidence chain', async ({ page }) => {
  await page.goto('/projects/demo-project/issues');
  await page.locator('.issue-row').filter({ hasText: '503' }).click();
  await expect(page.locator('.issue-heading h1')).toContainText('503');
  await expect(page.locator('.evidence-chain li')).toHaveCount(4);
  await expect(page.getByText('POST /payment/authorize → 503')).toBeVisible();
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
