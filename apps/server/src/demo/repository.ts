import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { demoSourceFiles } from './sourceMaps';

/**
 * 演示用的 git 仓库：虚构结账应用从 2.3.9 到 2.4.1 的提交历史，供代码类工具（读源码、搜代码、
 * 找嫌疑提交）使用。种子数据把两个版本的 commit_sha 设为这里的真实提交。
 *
 * 故事：2.3.9 里 calculateTotal 在 cart.summary 缺失时按商品逐项求和兜底；2.4.1 之前的一次性能优化
 * 改成直接读 cart.summary.total，而从旧会话恢复的购物车没有 summary，于是 2.4.1 上线后开始报错。
 * 两个版本之间还有一个无关的功能提交和一个发版提交，嫌疑提交要从中挑出改了堆栈里文件的那一个。
 *
 * 提交时间相对于「现在」，作者是虚构的；每次重建都会得到不同的提交号，种子同步写进 releases。
 */

const HOUR = 3_600_000;

const typesSource = `export interface CartItem {
  sku: string;
  price: number;
  quantity: number;
}

export interface CartSummary {
  total: number;
  currency: string;
}

export interface Cart {
  id: string;
  items: CartItem[];
  /** Only present when the server priced the cart in this session; restored carts do not have it. */
  summary?: CartSummary;
  promotion?: { kind: 'percent' | 'amount'; value: number };
  shipping?: { price: number };
  taxRate?: number;
}

export interface InventoryLine {
  sku: string;
  available: number;
  warehouseId: string;
}

export interface InventoryResponse {
  lines: Array<{ sku: string; available: number; warehouseId?: string }>;
}
`;

const moneySource = `export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
`;

const deliverySource = `export function deliveryWindowLabel(start: Date, end: Date): string {
  const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' });
  return \`Arrives between \${time.format(start)} and \${time.format(end)}\`;
}
`;

const readme = `# checkout-web

Checkout flow of the fictional shop used by the TracePilot demo.
`;

function packageJson(version: string): string {
  return `${JSON.stringify({ name: 'checkout-web', version, private: true }, null, 2)}\n`;
}

/** 2.3.9 的 total.ts：summary 缺失时逐项求和。由 2.4.1 的版本改回去，两者只差这两处。 */
function totalBefore(totalAfter: string): string {
  const guarded = totalAfter.replace(
    'const subtotal = cart.summary.total;',
    'const subtotal = cart.summary?.total ?? sumItems(cart);',
  );
  const withHelper = guarded.replace(
    'export function calculateTotal(',
    `function sumItems(cart: Cart): number {
  return roundCents(cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0));
}

export function calculateTotal(`,
  );
  if (withHelper === totalAfter || guarded === totalAfter) {
    throw new Error('The demo total.ts no longer matches the repository history.');
  }
  return withHelper;
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** git 不可用时返回 false：种子照常生成，只是没有代码上下文。 */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 <root>/<projectId> 重建演示仓库，返回两个版本的提交号。git 不可用时返回 null。
 * releases：两个版本的部署时间，提交时间据此往前推。
 */
export function createDemoRepository(
  root: string,
  projectId: string,
  releases: { previous: number; current: number },
): { previous: string; current: string } | null {
  if (!gitAvailable()) return null;
  const directory = join(root, projectId);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  run(directory, ['init', '--quiet']);
  // 不依赖本机 git 的默认分支名和签名配置。
  run(directory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  const commit = (message: string, author: [string, string], at: number) => {
    const date = new Date(at).toISOString();
    run(directory, ['add', '--all']);
    run(
      directory,
      ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', message],
      {
        GIT_AUTHOR_NAME: author[0],
        GIT_AUTHOR_EMAIL: author[1],
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author[0],
        GIT_COMMITTER_EMAIL: author[1],
        GIT_COMMITTER_DATE: date,
      },
    );
    return run(directory, ['rev-parse', 'HEAD']);
  };
  const mei: [string, string] = ['Mei Chen', 'mei.chen@shop.example'];
  const lin: [string, string] = ['Lin Wei', 'lin.wei@shop.example'];
  const bot: [string, string] = ['Release Bot', 'release-bot@shop.example'];

  const current = demoSourceFiles();
  const totalAfter = current['src/checkout/total.ts']!;
  writeFiles(directory, {
    ...current,
    'src/checkout/total.ts': totalBefore(totalAfter),
    'src/api/types.ts': typesSource,
    'src/lib/money.ts': moneySource,
    'README.md': readme,
    'package.json': packageJson('2.3.9'),
  });
  const previous = commit('release: checkout 2.3.9', bot, releases.previous - 2 * HOUR);
  run(directory, ['tag', 'v2.3.9', previous]);

  writeFiles(directory, { 'src/checkout/delivery.ts': deliverySource });
  commit(
    'feat(checkout): show the delivery window on the review step',
    mei,
    releases.current - 30 * HOUR,
  );

  writeFiles(directory, { 'src/checkout/total.ts': totalAfter });
  commit(
    'perf(checkout): reuse the cart summary total instead of re-summing items\n\n' +
      'Summing line items on every render showed up in the checkout profile;\n' +
      'the server already sends summary.total.',
    lin,
    releases.current - 6 * HOUR,
  );

  writeFiles(directory, { 'package.json': packageJson('2.4.1') });
  const head = commit('release: checkout 2.4.1', bot, releases.current - HOUR);
  run(directory, ['tag', 'v2.4.1', head]);
  return { previous, current: head };
}
