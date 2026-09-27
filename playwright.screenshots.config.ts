import { defineConfig, devices } from '@playwright/test';

/**
 * README 截图与 E2E 测试分开配置：截图会写入 docs/screenshots/，
 * 不应该在每次 `pnpm test:e2e` 时被重新生成。
 * 服务编排与种子数据复用同一套，因此截图和测试看到的是同一份确定性演示数据。
 */
export default defineConfig({
  testDir: './scripts/screenshots',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    // devices 先展开：它自带 viewport 和 deviceScaleFactor，放在后面会把下面的设置覆盖掉。
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    // 固定视口，保证多次生成的截图尺寸一致，README 里不会忽大忽小。
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    channel: process.env.CI ? undefined : 'chrome',
  },
  projects: [{ name: 'screenshots' }],
  webServer: [
    {
      command: 'pnpm --filter @trace-pilot/server dev',
      url: 'http://127.0.0.1:4318/health',
      // 即使 apps/server/.env 里配置了模型密钥，测试与截图也固定走离线脚本：
      // 结果确定、不产生费用。dotenv 不会覆盖已存在的环境变量，空字符串即可生效。
      env: { MODEL_API_KEY: '' },
      reuseExistingServer: true,
      timeout: 120_000,
      // pnpm 12 把脚本进程放进独立的进程组，Playwright 默认对进程组发 SIGKILL 时够不到它们：
      // vite / tsx 会成为孤儿并占着输出管道，测试结束后一直挂住。SIGTERM 能被 pnpm 转发给子进程。
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: 'pnpm --filter @trace-pilot/dashboard dev --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      timeout: 120_000,
      // pnpm 12 把脚本进程放进独立的进程组，Playwright 默认对进程组发 SIGKILL 时够不到它们：
      // vite / tsx 会成为孤儿并占着输出管道，测试结束后一直挂住。SIGTERM 能被 pnpm 转发给子进程。
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: 'pnpm --filter @trace-pilot/playground dev --host 127.0.0.1',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: true,
      timeout: 120_000,
      // pnpm 12 把脚本进程放进独立的进程组，Playwright 默认对进程组发 SIGKILL 时够不到它们：
      // vite / tsx 会成为孤儿并占着输出管道，测试结束后一直挂住。SIGTERM 能被 pnpm 转发给子进程。
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
