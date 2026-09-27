import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * SDK 运行时开销与泄漏回归。
 *
 * 体积只说明「下载多少字节」，说明不了「跑起来要花多少」。这个脚本在真实 Chromium 里测量
 * 初始化耗时、单次采集的同步开销、错误风暴下的行为，并验证反复 start/destroy 不泄漏。
 *
 * 两类结论要分开看：
 *
 * - **确定性断言**（监听器归零、全局 API 还原、丢弃计数自洽）——硬失败。
 *   它们不依赖机器快慢，任何一条不成立都是真的回归。
 * - **时间数字**——只作数量级回归的绊线，阈值留了约 10 倍余量。
 *   它们随机器负载波动，不是性能目标，也不该被当作 SLA 对外引用。
 *
 * SDK 通过 esbuild 以真实接入方的方式打包后注入页面，因此这里测的和
 * `pnpm measure:sdk` 称量的是同一条依赖解析路径。接入端点由 Playwright 路由拦截，
 * 与 harness 同源，避免 CORS 预检干扰测量。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ORIGIN = 'https://harness.local';
const DSN = `${ORIGIN}/api/v1/envelopes`;

// 阈值是数量级绊线，不是性能目标：正常值远低于此，触发说明出现了真实的量级退化。
const BUDGETS = {
  initP95Us: 2_000,
  captureP95Us: 250,
  stormTotalMs: 400,
  leakedListeners: 0,
};

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.once('error', rejectRun);
    child.once('exit', (code) =>
      code === 0
        ? resolveRun(output)
        : rejectRun(new Error(`${command} ${args.join(' ')}\n${output}`)),
    );
  });
}

/**
 * 测量前强制重新构建。SDK 的 exports 把 `import` 条件指向 dist，因此打包器读到的
 * 始终是构建产物而不是源码——不重建的话，这个脚本会安静地测一份过期的 SDK，
 * 连"故意破坏 teardown"这种改动都察觉不到。
 */
await run('pnpm', ['--filter', '@trace-pilot/shared', 'run', 'build']);
await run('pnpm', ['--filter', '@trace-pilot/monitor-sdk', 'run', 'build']);

const harnessSource = `
import { createMonitor } from '@trace-pilot/monitor-sdk';
window.__createMonitor = createMonitor;
`;

const bundle = await esbuild.build({
  stdin: {
    contents: harnessSource,
    // 与 measure-sdk 一致：以 workspace 内真实引用 SDK 的应用为解析目录。
    resolveDir: resolve(repoRoot, 'apps/playground'),
    sourcefile: 'runtime-harness.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  logLevel: 'warning',
});
const harnessScript = bundle.outputFiles[0].text;

// 与 playwright.config.ts 保持一致：本地用已安装的 Chrome，CI 用 Playwright 自带的 Chromium。
// 两者版本不同会影响时间数字，因此浏览器版本一并写进报告，任何数字都能归因。
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
const page = await browser.newPage();

let ingestRequests = 0;
await page.route(`${ORIGIN}/api/v1/envelopes`, async (route) => {
  ingestRequests += 1;
  await route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":0}' });
});
await page.route(`${ORIGIN}/**`, async (route) => {
  await route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>SDK runtime harness</title><main></main>',
  });
});

/**
 * 在任何页面脚本之前包装 EventTarget，记录仍然挂着的监听器。
 * 这是判断 teardown 是否真的对称的唯一可靠方式——只看代码读不出来，
 * 因为 removeEventListener 必须拿到与注册时同一个函数引用和同样的 capture 标志。
 */
await page.addInitScript(() => {
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  let nextId = 1;
  const ids = new WeakMap();
  const idOf = (value) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return String(value);
    }
    let id = ids.get(value);
    if (!id) {
      id = nextId++;
      ids.set(value, id);
    }
    return id;
  };
  const live = new Map();
  const keyOf = (target, type, handler, options) => {
    const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
    return `${idOf(target)}|${type}|${idOf(handler)}|${capture}`;
  };

  EventTarget.prototype.addEventListener = function (type, handler, options) {
    live.set(keyOf(this, type, handler, options), type);
    return originalAdd.call(this, type, handler, options);
  };
  EventTarget.prototype.removeEventListener = function (type, handler, options) {
    live.delete(keyOf(this, type, handler, options));
    return originalRemove.call(this, type, handler, options);
  };

  window.__liveListeners = () => [...live.values()];
});

await page.goto(`${ORIGIN}/`);
await page.addScriptTag({ content: harnessScript });

const report = await page.evaluate(
  async ({ dsn, samples }) => {
    const createMonitor = window.__createMonitor;
    const options = {
      dsn,
      dsnKey: 'runtime-probe',
      projectId: 'runtime-probe',
      release: '1.0.0',
      environment: 'production',
      // 关掉定时冲刷，让测量只反映采集路径本身，不掺入网络往返。
      flushInterval: 86_400_000,
      batchSize: 100_000,
      // 几百个实例在同一页面反复创建销毁：若开启退出持久化，前一个实例留下的事件会被
      // 后一个实例补发，队列与丢弃计数就不再只反映本轮操作。
      persistence: false,
    };

    const percentile = (values, quantile) => {
      const sorted = [...values].sort((a, b) => a - b);
      const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
      return sorted[Math.max(0, index)] ?? 0;
    };

    /**
     * 浏览器出于 Spectre 缓解把 performance.now() 的精度限制在约 100 µs，
     * 单次 createMonitor 或 captureException 都远低于这个分辨率——逐次计时只会
     * 量出「0 或 100」这样的量化噪声。因此这里一律测「一批的总耗时 / 批大小」，
     * 再对多批的均值取分位数：既高于时钟分辨率，又保留了分布。
     */
    const batchedMicros = (batches, perBatch, run) => {
      const means = [];
      for (let batch = 0; batch < batches; batch += 1) {
        const startedAt = performance.now();
        for (let index = 0; index < perBatch; index += 1) run(batch * perBatch + index);
        means.push(((performance.now() - startedAt) * 1000) / perBatch);
      }
      return means;
    };

    // ---- 1. 初始化耗时：createMonitor() + start() ----
    const created = [];
    const initMeans = batchedMicros(samples.initBatches, samples.initPerBatch, () => {
      const monitor = createMonitor(options);
      monitor.start();
      created.push(monitor);
    });
    for (const monitor of created) monitor.destroy();

    // ---- 2. 单次 captureException 的同步开销 ----
    // 每次用不同 message 并关掉去重，测的才是完整采集路径而不是提前退出。
    const captureMonitor = createMonitor({ ...options, dedupeWindow: 0 });
    captureMonitor.start();
    const errors = Array.from(
      { length: samples.captureBatches * samples.capturePerBatch },
      (_, index) => new Error(`runtime probe ${index}`),
    );
    const captureMeans = batchedMicros(samples.captureBatches, samples.capturePerBatch, (index) => {
      captureMonitor.captureException(errors[index]);
    });
    const capturedCount = captureMonitor.stats().pending;
    captureMonitor.destroy();

    // ---- 3a. 重复风暴：少数根因高频重复，验证短窗口去重 ----
    const repeatMonitor = createMonitor({ ...options, dedupeWindow: 5_000 });
    repeatMonitor.start();
    const repeatStartedAt = performance.now();
    for (let index = 0; index < samples.storm; index += 1) {
      repeatMonitor.captureException(new Error(`storm signature ${index % 10}`));
    }
    const repeatTotalMs = performance.now() - repeatStartedAt;
    const repeatQueued = repeatMonitor.stats().pending;
    repeatMonitor.destroy();

    // ---- 3b. 独特风暴：全部签名互不相同，去重帮不上忙，只能靠队列上限兜底 ----
    // 这是服务端不可达 + 错误各不相同的最坏情况，也是队列上限唯一真正生效的场景。
    const uniqueCap = 50;
    const uniqueMonitor = createMonitor({
      ...options,
      dedupeWindow: 0,
      maxQueueSize: uniqueCap,
    });
    uniqueMonitor.start();
    for (let index = 0; index < samples.uniqueStorm; index += 1) {
      uniqueMonitor.captureException(new Error(`unique failure ${index}`));
    }
    const uniqueStats = uniqueMonitor.stats();
    const uniqueQueued = uniqueStats.pending;
    const uniqueDropped = Object.values(uniqueStats.dropped).reduce((sum, count) => sum + count, 0);
    uniqueMonitor.destroy();

    // ---- 4. 反复 start/destroy 是否泄漏 ----
    const listenersBefore = window.__liveListeners().length;
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    for (let index = 0; index < samples.cycles; index += 1) {
      const monitor = createMonitor(options);
      monitor.start();
      monitor.captureMessage(`cycle ${index}`);
      monitor.destroy();
    }
    const listenersAfter = window.__liveListeners().length;

    const globalsRestored = {
      fetch: window.fetch === originalFetch,
      xhrOpen: XMLHttpRequest.prototype.open === originalOpen,
      xhrSend: XMLHttpRequest.prototype.send === originalSend,
      pushState: history.pushState === originalPushState,
      replaceState: history.replaceState === originalReplaceState,
    };

    // 堆用量只作参考：JIT 与 GC 时机让它天然带噪声，不作断言，也不作为对外引用的数字。
    const heapBytes =
      performance.memory && typeof performance.memory.usedJSHeapSize === 'number'
        ? performance.memory.usedJSHeapSize
        : null;

    return {
      init: {
        note: '每批总耗时 / 批大小，再对批均值取分位数；单次调用低于浏览器时钟分辨率。',
        batches: samples.initBatches,
        perBatch: samples.initPerBatch,
        p50Us: Number(percentile(initMeans, 0.5).toFixed(1)),
        p95Us: Number(percentile(initMeans, 0.95).toFixed(1)),
      },
      capture: {
        note: '同上，逐次计时只会量出时钟量化噪声。',
        batches: samples.captureBatches,
        perBatch: samples.capturePerBatch,
        queued: capturedCount,
        p50Us: Number(percentile(captureMeans, 0.5).toFixed(1)),
        p95Us: Number(percentile(captureMeans, 0.95).toFixed(1)),
      },
      repeatStorm: {
        note: '少数根因高频重复：去重应把绝大多数事件挡在队列之外。',
        raised: samples.storm,
        distinctSignatures: 10,
        queued: repeatQueued,
        suppressed: samples.storm - repeatQueued,
        totalMs: Number(repeatTotalMs.toFixed(1)),
      },
      uniqueStorm: {
        note: '签名互不相同，去重无效，只能由队列上限兜底。',
        raised: samples.uniqueStorm,
        queueCap: uniqueCap,
        queued: uniqueQueued,
        dropped: uniqueDropped,
      },
      lifecycle: {
        cycles: samples.cycles,
        listenersBefore,
        listenersAfter,
        leaked: listenersAfter - listenersBefore,
        globalsRestored,
      },
      heapBytesAfterCycles: heapBytes,
    };
  },
  {
    dsn: DSN,
    samples: {
      initBatches: 20,
      initPerBatch: 10,
      captureBatches: 20,
      capturePerBatch: 200,
      storm: 500,
      uniqueStorm: 200,
      cycles: 20,
    },
  },
);

const browserVersion = browser.version();
const browserName = process.env.CI ? 'Chromium (Playwright)' : 'Chrome (system)';
await browser.close();

report.browser = `${browserName} ${browserVersion}`;
report.ingestRequestsObserved = ingestRequests;
report.measuredAt = new Date().toISOString();
report.budgets = BUDGETS;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const failures = [];

// ---- 确定性断言：与机器快慢无关，不成立即为真实回归 ----
if (report.lifecycle.leaked > BUDGETS.leakedListeners) {
  failures.push(
    `${report.lifecycle.cycles} 轮 start/destroy 后残留 ${report.lifecycle.leaked} 个监听器。` +
      'teardown 未对称移除——注意 removeEventListener 必须使用与注册时相同的函数引用和 capture 标志。',
  );
}
const unrestored = Object.entries(report.lifecycle.globalsRestored)
  .filter(([, restored]) => !restored)
  .map(([name]) => name);
if (unrestored.length > 0) {
  failures.push(`destroy() 之后这些全局 API 未还原：${unrestored.join(', ')}。`);
}
// 重复风暴：去重必须把绝大多数同签名事件挡住，否则短窗口去重已失效。
if (report.repeatStorm.queued > report.repeatStorm.distinctSignatures) {
  failures.push(
    `重复风暴中 ${report.repeatStorm.raised} 个错误只有 ${report.repeatStorm.distinctSignatures} 种签名，` +
      `却有 ${report.repeatStorm.queued} 条进入队列——短窗口去重已失效。`,
  );
}
// 独特风暴：签名各异时去重帮不上忙，队列必须被上限截住并如实记录丢弃数。
if (report.uniqueStorm.queued > report.uniqueStorm.queueCap) {
  failures.push(
    `队列上限未生效：cap=${report.uniqueStorm.queueCap}，实际驻留 ${report.uniqueStorm.queued} 条。`,
  );
}
const expectedDropped = report.uniqueStorm.raised - report.uniqueStorm.queueCap;
if (report.uniqueStorm.dropped !== expectedDropped) {
  failures.push(
    `丢弃计数不自洽：raised=${report.uniqueStorm.raised}、cap=${report.uniqueStorm.queueCap}，` +
      `预期丢弃 ${expectedDropped} 条，实际 ${report.uniqueStorm.dropped} 条。`,
  );
}

// ---- 时间绊线：只拦数量级退化 ----
if (report.init.p95Us > BUDGETS.initP95Us) {
  failures.push(`初始化 P95 ${report.init.p95Us} µs 超出绊线 ${BUDGETS.initP95Us} µs。`);
}
if (report.capture.p95Us > BUDGETS.captureP95Us) {
  failures.push(`单次采集 P95 ${report.capture.p95Us} µs 超出绊线 ${BUDGETS.captureP95Us} µs。`);
}
if (report.repeatStorm.totalMs > BUDGETS.stormTotalMs) {
  failures.push(
    `${report.repeatStorm.raised} 个错误的风暴占用主线程 ${report.repeatStorm.totalMs} ms，` +
      `超出绊线 ${BUDGETS.stormTotalMs} ms。`,
  );
}

if (failures.length > 0) {
  console.error(`\n运行时回归未通过：\n${failures.map((item) => `  - ${item}`).join('\n')}`);
  process.exit(1);
}
