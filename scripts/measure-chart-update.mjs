import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import * as esbuild from 'esbuild';

/**
 * 图表更新策略的对照测量。
 *
 * `Chart.tsx` 原先把实例创建和数据更新写在同一个 effect 里，依赖数组是 `[option]`——
 * option 引用一变就 dispose 再 init。而上游的 useMemo 依赖 React Query 的 data，
 * 每次 refetch 都产生新引用，于是每轮轮询所有图表整体重建。
 * 改造后拆成两个 effect：`[]` 只管 init/dispose，`[option]` 只调 setOption。
 *
 * **这个脚本测的是两种模式的隔离复现，不是端到端页面测量。** 改造前的代码已经不在仓库里，
 * 临时回退再测的结果无法由命令复现；所以这里在同一个页面、同一份 option 形状下并排跑
 * 两种策略。option 形状取自 Dashboard 实际使用的图表：一个三系列柱状、一个折线、
 * 三个环形饼图——对应 Performance 页与 Issue 详情页一屏的真实构成。
 *
 * 真实组件确实按「复用」方式工作，由 `tests/e2e/chart-instance-reuse.spec.ts` 保证：
 * 它断言容器内的 canvas 节点在 option 变化后保持同一引用。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ORIGIN = 'https://chart-harness.local';

/**
 * 这条断言校验的是**测量本身的前提**——「复用」那一组确实没有重建实例，
 * 否则两组的对比就没有意义。它不是 `Chart.tsx` 的回归保护：
 * 组件层的保证在 `tests/e2e/chart-instance-reuse.spec.ts`，
 * 那里断言真实组件的 canvas 节点在 option 变化后保持同一引用。
 */
const BUDGETS = { reuseCanvasesDuringUpdates: 0 };

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

// 与 measure:sdk / measure:sdk-runtime 一致：先构建，避免测到过期产物。
await run('pnpm', ['--filter', '@trace-pilot/shared', 'run', 'build']);

/** 注册的模块与 `Chart.tsx` 完全一致，否则测的不是同一套渲染路径。 */
const harnessSource = `
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);
window.__echarts = echarts;
`;

const bundle = await esbuild.build({
  stdin: {
    contents: harnessSource,
    // 从 Dashboard 解析 echarts，用的是它自己依赖树里的那一份。
    resolveDir: resolve(repoRoot, 'apps/dashboard'),
    sourcefile: 'chart-harness.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  logLevel: 'warning',
});

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.route(`${ORIGIN}/**`, async (route) => {
  await route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>chart harness</title><body style="margin:0"></body>',
  });
});

// 统计 canvas 创建数：ECharts 在 init 时创建画布，复用策略下更新阶段应当一个都不新建。
await page.addInitScript(() => {
  const original = document.createElement.bind(document);
  window.__canvasCount = 0;
  document.createElement = function (tag, options) {
    if (String(tag).toLowerCase() === 'canvas') window.__canvasCount += 1;
    return original(tag, options);
  };
});

await page.goto(`${ORIGIN}/`);
await page.addScriptTag({ content: bundle.outputFiles[0].text });

const report = await page.evaluate(
  async ({ charts, updates, rounds }) => {
    const echarts = window.__echarts;

    // 与 Dashboard 实际使用的 option 形状一致：三系列柱状、单系列折线、三个环形饼图。
    const barOption = (seed) => ({
      animation: false,
      grid: { left: 0, right: 10, top: 20, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] },
      yAxis: { type: 'value' },
      series: ['p50', 'p75', 'p95'].map((name, index) => ({
        name,
        type: 'bar',
        data: Array.from({ length: 5 }, (_, i) => (seed * 7 + i * 13 + index * 29) % 3000),
      })),
    });
    const lineOption = (seed) => ({
      animation: false,
      grid: { left: 0, right: 14, top: 24, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: Array.from({ length: 7 }, (_, i) => `D${i}`),
      },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'line',
          data: Array.from({ length: 7 }, (_, i) => (seed * 11 + i * 17) % 2500),
          areaStyle: {},
        },
      ],
    });
    const pieOption = (seed) => ({
      animation: false,
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'pie',
          radius: ['58%', '78%'],
          center: ['38%', '50%'],
          data: ['Chrome', 'Edge', 'Safari', 'Firefox'].map((name, i) => ({
            name,
            value: (seed * 3 + i * 19) % 100,
          })),
        },
      ],
    });
    // 一屏的真实构成：Performance 页 2 个（柱+线）+ Issue 详情 3 个饼图。
    const builders = [barOption, lineOption, pieOption, pieOption, pieOption].slice(0, charts);

    const containers = builders.map((_, index) => {
      const element = document.createElement('div');
      element.style.cssText = `width:640px;height:${index === 0 ? 340 : 260}px`;
      document.body.appendChild(element);
      return element;
    });

    const init = (container) => echarts.init(container, undefined, { renderer: 'canvas' });

    /**
     * 改造前：每次 option 变化都销毁重建整个实例。
     * 返回一轮轮询（所有图表各更新一次）的耗时。
     */
    function rebuildRound(seed) {
      const startedAt = performance.now();
      for (let index = 0; index < builders.length; index += 1) {
        const chart = init(containers[index]);
        chart.setOption(builders[index](seed));
        chart.dispose();
      }
      return performance.now() - startedAt;
    }

    /** 改造后：实例只创建一次，option 变化时只 setOption。 */
    function reuseRound(instances, seed) {
      const startedAt = performance.now();
      for (let index = 0; index < instances.length; index += 1) {
        instances[index].setOption(builders[index](seed));
      }
      return performance.now() - startedAt;
    }

    const percentile = (values, q) => {
      const sorted = [...values].sort((a, b) => a - b);
      return (
        sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))] ?? 0
      );
    };

    // 预热一轮，让 JIT 与 ECharts 内部缓存进入稳定状态，避免首轮成本压在某一种策略上。
    rebuildRound(0);
    const warm = containers.map(init);
    reuseRound(warm, 0);
    for (const chart of warm) chart.dispose();

    // —— 改造前 ——
    const rebuildCanvasStart = window.__canvasCount;
    const rebuildRounds = [];
    for (let round = 0; round < rounds; round += 1) {
      let total = 0;
      for (let update = 0; update < updates; update += 1)
        total += rebuildRound(round * updates + update + 1);
      rebuildRounds.push(total / updates);
    }
    const rebuildCanvases = window.__canvasCount - rebuildCanvasStart;

    // —— 改造后 ——
    const instances = containers.map(init);
    // ECharts 在首次 setOption 时会惰性创建额外图层。真实的轮询更新发生在已渲染的图表上，
    // 所以先渲染一次再开始计数，测的才是稳态更新而不是首帧。
    reuseRound(instances, 0);
    const reuseCanvasStart = window.__canvasCount;
    const reuseRounds = [];
    for (let round = 0; round < rounds; round += 1) {
      let total = 0;
      for (let update = 0; update < updates; update += 1)
        total += reuseRound(instances, round * updates + update + 1);
      reuseRounds.push(total / updates);
    }
    const reuseCanvases = window.__canvasCount - reuseCanvasStart;
    for (const chart of instances) chart.dispose();

    return {
      setup: { chartsPerScreen: builders.length, updatesPerRound: updates, rounds },
      rebuild: {
        note: '改造前：option 引用一变就 dispose + init 整个实例。',
        perPollingCycleP50Ms: Number(percentile(rebuildRounds, 0.5).toFixed(2)),
        perPollingCycleP95Ms: Number(percentile(rebuildRounds, 0.95).toFixed(2)),
        canvasesCreated: rebuildCanvases,
      },
      reuse: {
        note: '改造后：实例只创建一次，option 变化时只 setOption。',
        perPollingCycleP50Ms: Number(percentile(reuseRounds, 0.5).toFixed(2)),
        perPollingCycleP95Ms: Number(percentile(reuseRounds, 0.95).toFixed(2)),
        canvasesCreated: reuseCanvases,
      },
    };
  },
  { charts: 5, updates: 20, rounds: 15 },
);

const browserVersion = browser.version();
await browser.close();

report.caveats = [
  'option 关闭了动画，测的是 setOption 的同步开销。真实图表是有动画的：重建策略下每轮轮询都会',
  '重放一次入场动画，那部分 rAF 工作和肉眼可见的闪烁不在这个数字里——所以实际差距比这里更大。',
  '这是两种模式的隔离复现，不是端到端页面测量；真实组件的行为由 E2E 的 canvas 引用断言保证。',
];
report.speedup = Number(
  (
    report.rebuild.perPollingCycleP50Ms / Math.max(report.reuse.perPollingCycleP50Ms, 0.001)
  ).toFixed(1),
);
report.browser = `${process.env.CI ? 'Chromium (Playwright)' : 'Chrome (system)'} ${browserVersion}`;
report.measuredAt = new Date().toISOString();
report.budgets = BUDGETS;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const failures = [];
// 唯一的硬断言：复用策略在更新阶段不得新建 canvas。这与机器快慢无关。
if (report.reuse.canvasesCreated > BUDGETS.reuseCanvasesDuringUpdates) {
  failures.push(
    `对照失效：复用组在 ${report.setup.rounds * report.setup.updatesPerRound} 次更新中新建了 ` +
      `${report.reuse.canvasesCreated} 个 canvas，说明它并没有真的复用实例，两组数字不可比。`,
  );
}
if (report.rebuild.canvasesCreated === 0) {
  failures.push('对照组未创建任何 canvas，测量本身失效——请检查 harness 是否真的渲染了图表。');
}

if (failures.length > 0) {
  console.error(`\n图表更新策略回归未通过：\n${failures.map((item) => `  - ${item}`).join('\n')}`);
  process.exit(1);
}
