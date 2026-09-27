import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 驱动真实 Chromium，覆盖 Playground → Server → Dashboard 的完整链路。
 * 三个 webServer 会按健康 URL 等待就绪，本地已有服务时直接复用。
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  // E2E 共用由 globalSetup 重建的 demo-project 数据，串行可避免用例互相竞争状态。
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: process.env.CI ? undefined : 'chrome',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @trace-pilot/server dev',
      url: 'http://127.0.0.1:4318/health',
      // 即使 apps/server/.env 里配置了模型密钥，测试与截图也固定走离线脚本：
      // 结果确定、不产生费用。dotenv 不会覆盖已存在的环境变量，空字符串即可生效。
      env: { MODEL_API_KEY: '' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @trace-pilot/dashboard dev --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @trace-pilot/playground dev --host 127.0.0.1',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
