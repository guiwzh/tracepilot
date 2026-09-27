import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';

/**
 * SDK 送达回归：用 SDK 默认配置、真实 Chrome、真实跨域 Server，验证事件确实入库。
 *
 * 单元测试注入的是假 fetch / 假 sendBeacon，看不到浏览器自己的限制；下面两条路径都曾在
 * 单元测试全绿的情况下静默丢数据：
 * - keepalive 请求体共享 64 KiB 在途配额，超出直接 TypeError；
 * - application/json 的 sendBeacon 跨域时需要带凭据的预检，Server 未允许凭据时
 *   sendBeacon 仍返回 true，但真正的 POST 从未发出。
 */
const API = 'http://127.0.0.1:4318';

/**
 * 测试页由一个真实的本机 HTTP 服务提供，端口与接入端不同，因此上报是真正的跨域请求。
 * 不用 page.route 伪造页面：那样的页面没有来源地址，Chrome 的 Local Network Access
 * 会把它当成公网页面并拦截它访问 127.0.0.1，卸载时的 beacon 更是连授权都拿不到。
 * 页面上只有这里注入的一个 SDK 实例。
 */
let harnessServer: Server;
let harnessUrl = '';

/**
 * 这组测试写入一个独立的临时项目：其他 E2E 用例断言的是种子项目里确定的计数，
 * 往 demo-project 里多写几十条事件就会让它们全部失败。
 */
const project = { id: '', dsnKey: '' };

test.beforeAll(async () => {
  const created = await fetch(`${API}/api/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `SDK delivery ${Date.now()}` }),
  });
  expect(created.status).toBe(201);
  Object.assign(project, (await created.json()) as { id: string; dsnKey: string });

  const bundle = await esbuild.build({
    stdin: {
      contents: `import { createMonitor } from '@trace-pilot/monitor-sdk';
window.__createMonitor = createMonitor;`,
      resolveDir: resolve('apps/playground'),
      sourcefile: 'sdk-delivery-harness.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // 直接打包源码，测试不依赖 dist 是否刚构建过。
    conditions: ['development'],
    write: false,
    logLevel: 'warning',
  });
  const html = `<!doctype html><title>SDK harness</title><script>${bundle.outputFiles[0]!.text}</script>`;
  harnessServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  });
  await new Promise<void>((ready) => harnessServer.listen(0, '127.0.0.1', ready));
  harnessUrl = `http://127.0.0.1:${(harnessServer.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise((closed) => harnessServer.close(closed));
});

// 指纹会把 4 位以上数字、UUID 和时间戳归一化成占位符，所以运行标识只用字母，保证能被搜索到。
function runId(prefix: string): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return `${prefix}${Array.from({ length: 10 }, () => letters[Math.floor(Math.random() * 26)]).join('')}`;
}

async function openHarness(page: Page): Promise<void> {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => '__createMonitor' in window);
}

async function matchingIssues(request: APIRequestContext, search: string): Promise<number> {
  const response = await request.get(
    `${API}/api/v1/projects/${project.id}/issues?pageSize=100&search=${search}`,
  );
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { total: number }).total;
}

const monitorOptions = () => ({
  dsn: `${API}/api/v1/envelopes`,
  dsnKey: project.dsnKey,
  projectId: project.id,
  release: '1.0.0',
  environment: 'production',
});

test('an error storm carrying full breadcrumb trails reaches the server with default settings', async ({
  page,
  request,
}) => {
  const id = runId('storm');
  await openHarness(page);
  await page.evaluate(
    async ({ api, id, options }) => {
      const monitor = (window as unknown as { __createMonitor: CreateMonitor }).__createMonitor(
        options,
      );
      monitor.start();
      // 50 次真实请求把 breadcrumb 填满，模拟一个活跃的业务页面；每条 breadcrumb 都带 URL、状态和耗时。
      for (let index = 0; index < 50; index += 1) {
        await fetch(`${api}/health?probe=${id}&step=${index}`);
      }
      for (const letter of 'abcdefghij') {
        monitor.captureException(new Error(`${id} storm failure ${letter}`));
      }
      await monitor.flush();

      type CreateMonitor = (value: typeof options) => {
        start(): void;
        captureException(error: unknown): string | null;
        flush(): Promise<void>;
      };
    },
    { api: API, id, options: monitorOptions() },
  );

  await expect.poll(() => matchingIssues(request, id), { timeout: 10_000 }).toBe(10);
});

test('events still queued at page exit reach a cross-origin server', async ({ page, request }) => {
  const id = runId('exit');
  await openHarness(page);
  await page.evaluate(
    ({ id, options }) => {
      const monitor = (
        window as unknown as {
          __createMonitor: (value: typeof options) => {
            start(): void;
            captureMessage(message: string, level: string): string | null;
          };
        }
      ).__createMonitor(options);
      monitor.start();
      // 只有一条事件，达不到批量阈值，也等不到定时发送：它只能靠退出路径送达。
      monitor.captureMessage(`${id} queued at exit`, 'warning');
    },
    { id, options: monitorOptions() },
  );

  // 离开页面触发 pagehide，SDK 只能在这一刻用 sendBeacon 把队列交给浏览器。
  await page.goto('about:blank');

  await expect.poll(() => matchingIssues(request, id), { timeout: 10_000 }).toBe(1);
});
