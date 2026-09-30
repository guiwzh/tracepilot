import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * SDK 体积测量与预算回归。
 *
 * 这个脚本报告两个口径，因为它们回答的是不同的问题：
 *
 * 1. 产物体积  —— 我们发布的那个文件有多大。
 * 2. 接入成本  —— 业务应用把 SDK 打进自己的包后，实际多付出多少字节。
 *
 * 两者会显著背离：库打包工具（tsdown，此前是 tsup）默认把依赖 external 化，所以产物里只留下
 * `import ... from "@trace-pilot/shared"`，而 shared 的 barrel 会连带引入 zod。
 * 只测产物就会漏掉这条依赖链——历史上这里真实少算过约 4.2 倍。
 * 因此接入成本由一次真实打包测得，并额外断言产物中不含 zod 运行时代码。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactPath = resolve(repoRoot, 'packages/monitor-sdk/dist/index.js');

// 预算留了约 15% 余量：既能挡住依赖链回归，又不会因为正常改动天天报警。
// 2026-09 引入 web-vitals 后重新设定：它被 external 化，只体现在接入成本里，约占 2.9 KB gzip。
// 2026-09-28 再次设定：SDK 端默认脱敏（含 shared 的脱敏规则）、噪声过滤与多类型去重、
// 跨周期退避与 Retry-After、按标签页持久化、React 错误回调适配器，产物 +1.8 KB、接入 +2.2 KB gzip，
// 明细见 docs/reports/performance.md。
// 2026-09-30 再次设定：web-vitals 换成归因版本（LCP、CLS、INP 的元素与分段耗时），它被 external 化，
// 接入成本里 web-vitals 从 2.9 KB 变为 5.3 KB gzip；同期请求失败判定与业务码检查使产物 +0.6 KB。
// 2026-09-30 当天再次设定：新增白屏检测（约 0.8 KB）、控制台面包屑（约 0.4 KB）与 cause 链，
// 产物 +1.4 KB、接入 +1.4 KB gzip。
const BUDGETS = {
  artifactGzipBytes: 10_800,
  consumerGzipBytes: 17_300,
  consumerZodIdentifiers: 0,
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
 * 测量前强制重新构建。缺了这一步，脚本会称量 dist 里碰巧存在的任何东西——
 * 例如切换分支之前留下的旧产物，报告出一个与当前源码无关的数字而不给出任何警告。
 */
await run('pnpm', ['--filter', '@trace-pilot/shared', 'run', 'build']);
await run('pnpm', ['--filter', '@trace-pilot/monitor-sdk', 'run', 'build']);

const artifact = await readFile(artifactPath);
const artifactText = artifact.toString('utf8');

// 即使刚刚构建过，也复核产物确实经过压缩：万一构建配置里的 minify 被删掉，
// 这里要直接失败，而不是安静地报告一个更大的数字。
const lineCount = artifactText.split('\n').length;
if (lineCount > 5 || artifactText.includes('\n  ')) {
  console.error(
    `产物看起来未经压缩（${lineCount} 行，且包含缩进）。\n` +
      '请检查 packages/monitor-sdk/tsdown.config.ts 是否仍设置 minify: true。',
  );
  process.exit(1);
}

/**
 * 以真实接入方的身份打包一次。解析目录选 apps/playground，
 * 因为它是本仓库里唯一通过 workspace 依赖真实引用 SDK 的应用，
 * 走的是和外部业务应用完全相同的 exports 与 node_modules 解析路径。
 */
const consumerSource = `
import { createMonitor } from '@trace-pilot/monitor-sdk';
const monitor = createMonitor({
  dsn: 'https://ingest.example/api/v1/envelopes',
  projectId: 'probe',
  release: '1.0.0',
  environment: 'production',
});
monitor.start();
globalThis.__sizeProbe = monitor;
`;

async function bundleConsumer(external = []) {
  const bundled = await esbuild.build({
    stdin: {
      contents: consumerSource,
      resolveDir: resolve(repoRoot, 'apps/playground'),
      sourcefile: 'consumer-probe.js',
      loader: 'js',
    },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    external,
    write: false,
    logLevel: 'warning',
  });
  return bundled.outputFiles[0].text;
}

const consumerBundle = await bundleConsumer();
// 把 web-vitals 排除后再打一次，差值就是这个依赖在接入方包里的实际份额。
const withoutWebVitals = Buffer.from(await bundleConsumer(['web-vitals']));
// zod 的类名在压缩后仍然保留，因此可以作为“运行时依赖是否泄漏进浏览器包”的可靠信号。
const zodIdentifiers = (consumerBundle.match(/\bZod[A-Z]\w*/g) ?? []).length;
const consumerBytes = Buffer.from(consumerBundle);

const report = {
  artifact: {
    path: 'packages/monitor-sdk/dist/index.js',
    note: '发布产物本身；不含 Source Map、类型声明，也不含 external 化的 workspace 依赖。',
    minifiedBytes: artifact.byteLength,
    gzipBytes: gzipSync(artifact, { level: 9 }).byteLength,
  },
  consumer: {
    note: '业务应用打包 createMonitor 后实际增加的体积，含全部被拉入的运行时依赖。',
    bundler: `esbuild ${esbuild.version}`,
    minifiedBytes: consumerBytes.byteLength,
    gzipBytes: gzipSync(consumerBytes, { level: 9 }).byteLength,
    zodIdentifiers,
    webVitalsGzipBytes:
      gzipSync(consumerBytes, { level: 9 }).byteLength -
      gzipSync(withoutWebVitals, { level: 9 }).byteLength,
  },
  budgets: BUDGETS,
  measuredAt: new Date().toISOString(),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const failures = [];
if (report.artifact.gzipBytes > BUDGETS.artifactGzipBytes) {
  failures.push(`产物 gzip ${report.artifact.gzipBytes} B 超出预算 ${BUDGETS.artifactGzipBytes} B`);
}
if (report.consumer.gzipBytes > BUDGETS.consumerGzipBytes) {
  failures.push(
    `接入成本 gzip ${report.consumer.gzipBytes} B 超出预算 ${BUDGETS.consumerGzipBytes} B`,
  );
}
if (zodIdentifiers > BUDGETS.consumerZodIdentifiers) {
  failures.push(
    `接入方产物中出现 ${zodIdentifiers} 处 zod 运行时标识符。` +
      'shared 或 monitor-sdk 可能丢失了 "sideEffects": false，导致 barrel 里的 zod 无法被摇除。',
  );
}

if (failures.length > 0) {
  console.error(`\n体积预算未通过：\n${failures.map((item) => `  - ${item}`).join('\n')}`);
  process.exit(1);
}
