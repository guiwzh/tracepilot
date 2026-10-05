import 'dotenv/config';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';
import { loadConfig } from './config';
import { createDatabase, ensureDemoProject, type TraceDatabase } from './db/client';
import { createDemoRepository } from './demo/repository';
import { buildSourceMap, DEMO_SOURCE_MAPS } from './demo/sourceMaps';
import { ingestEnvelope } from './services/events';
import { saveSourceMap } from './services/sourcemaps';

/**
 * 演示数据脚本（pnpm seed）：清空并重建 demo-project 的虚构数据、两个版本的 Source Map，
 * 以及（给了仓库根目录时）演示用的 git 仓库，两个版本的 commit_sha 指向其中的真实提交。
 *
 * 通过正式的 saveSourceMap 和 ingestEnvelope 写入，而不是直接往 issues 表插最终结果，
 * 因此演示数据也会经过还原、指纹、脱敏、聚合和计数的真实生产代码。
 * 顺序与推荐的接入方式一致：先上传 map（构建时上传），再有线上流量，聚合才能用上还原后的栈帧。
 */

const browsers = [
  'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/132.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0',
  'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0',
];

// 额外的错误根因让演示数据超过一页，分页、搜索和不同 Issue 详情都能在默认数据中实际操作。
const checkoutFailureVariants = [
  ['CheckoutStateError', 'Checkout state failed to hydrate', 'hydrateCheckoutState'],
  ['PromotionError', 'Promotion response contained an invalid discount', 'applyPromotion'],
  ['AddressError', 'Address validation service returned no candidates', 'validateAddress'],
  ['DeliveryError', 'Selected delivery window is no longer available', 'reserveDeliveryWindow'],
  ['CurrencyError', 'Currency formatter received a non-numeric total', 'formatCurrency'],
  ['CartItemError', 'Cart item price was missing during checkout', 'normalizeCartItem'],
  ['PaymentMountError', 'Payment method component failed to mount', 'mountPaymentMethod'],
  ['ShippingError', 'Shipping country is not supported', 'resolveShippingMethod'],
  ['TaxError', 'Tax estimate request exceeded its deadline', 'loadTaxEstimate'],
  ['ReservationError', 'Inventory reservation conflicted with another session', 'reserveInventory'],
  ['StateSyncError', 'Checkout state diverged from the server snapshot', 'reconcileCheckout'],
  ['PaymentFrameError', 'Payment frame handshake was rejected', 'connectPaymentFrame'],
] as const;

function breadcrumb(
  eventId: string,
  index: number,
  timestamp: number,
  type: Breadcrumb['type'],
  category: string,
  message: string,
  data?: Record<string, unknown>,
): Breadcrumb {
  return { id: `${eventId}-crumb-${index}`, type, category, message, timestamp, data };
}

/**
 * 演示事件的 trace：假定商店给 api.shop.example 配置了 tracePropagationTargets，同一次页面浏览里的请求
 * 共用一个 trace id，各有自己的 span id。由事件 id 推出来，重新 seed 时不变。
 */
export function demoTrace(eventId: string): { traceId: string; span: (request: string) => string } {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return {
    traceId: hash(`trace:${eventId}`).slice(0, 32),
    span: (request) => hash(`span:${eventId}:${request}`).slice(0, 16),
  };
}

function baseEvent(
  id: string,
  timestamp: number,
  index: number,
): Omit<MonitorEvent, 'eventType' | 'payload'> {
  const route = index % 4 === 0 ? '/checkout/review' : index % 3 === 0 ? '/cart' : '/checkout';
  const trace = demoTrace(id);
  return {
    eventId: id,
    timestamp,
    projectId: 'demo-project',
    release: index % 7 === 0 ? '2.3.9' : '2.4.1',
    environment: 'production',
    page: { url: `https://shop.example${route}?session=demo-${index}`, route, title: 'Checkout' },
    traceId: trace.traceId,
    user: { id: `customer-${(index % 18) + 1}` },
    device: {
      userAgent: browsers[index % browsers.length]!,
      language: index % 5 === 0 ? 'zh-CN' : 'en-US',
      viewport: { width: index % 4 === 0 ? 390 : 1440, height: index % 4 === 0 ? 844 : 900 },
    },
    breadcrumbs: [
      breadcrumb(id, 1, timestamp - 9_200, 'navigation', 'route', `pushState → ${route}`),
      breadcrumb(
        id,
        2,
        timestamp - 6_800,
        'click',
        'ui.click',
        'button.checkout-step “Continue to payment”',
      ),
      breadcrumb(
        id,
        3,
        timestamp - 3_100,
        'network',
        'http',
        'GET https://api.shop.example/cart → 200',
        {
          method: 'GET',
          url: 'https://api.shop.example/cart?token=removed',
          status: 200,
          duration: 142 + index,
          traceId: trace.traceId,
          spanId: trace.span('cart'),
        },
      ),
    ],
  };
}

const HOUR = 3_600_000;

export async function seedDemoData(
  database: TraceDatabase,
  sourceMapDir: string,
  repositoryRoot: string | null = null,
): Promise<{ events: number; sourceMaps: number; repository: boolean }> {
  ensureDemoProject(database);
  // 删除 releases 会级联清掉 source_maps 表行，但磁盘上的 .map 文件不会跟着消失。
  // 先取出待删记录的路径，删完表数据后逐个删除文件，避免反复 seed 在私有目录里堆积孤儿文件。
  const orphanedMaps = database.sqlite
    .prepare(
      `SELECT map_path FROM source_maps
       WHERE release_id IN (SELECT id FROM releases WHERE project_id = 'demo-project')`,
    )
    .all() as Array<{ map_path: string }>;

  // 只重建内置 demo-project，用户自行创建的其他项目不会被删除。
  // 删除 issues 时，外键 ON DELETE CASCADE 会一并删掉它的调查记录。
  database.sqlite.exec(`
    DELETE FROM diagnoses WHERE issue_id IN (SELECT id FROM issues WHERE project_id = 'demo-project');
    DELETE FROM events WHERE issue_id IN (SELECT id FROM issues WHERE project_id = 'demo-project')
      OR release_id IN (SELECT id FROM releases WHERE project_id = 'demo-project');
    DELETE FROM issues WHERE project_id = 'demo-project';
    DELETE FROM releases WHERE project_id = 'demo-project';
  `);
  for (const { map_path: mapPath } of orphanedMaps) {
    // 文件可能已被手动清理；删不掉不应让重建演示数据失败。
    rmSync(mapPath, { force: true });
  }
  const now = Date.now();
  // 部署时间要早于各自版本的事件：2.4.1 的事件从约 21 小时前开始，它在 26 小时前上线。
  // 曾经 2.4.1 记成一小时前部署，而它的事件早在那之前就有了，排障 Agent 会被这个矛盾带偏。
  const deployedAt = { previous: now - 5 * 24 * HOUR, current: now - 26 * HOUR };
  const commits = repositoryRoot
    ? createDemoRepository(repositoryRoot, 'demo-project', deployedAt)
    : null;
  const insertRelease = database.sqlite.prepare(
    'INSERT INTO releases (id, project_id, version, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertRelease.run(
    'demo-release-2-4-1',
    'demo-project',
    '2.4.1',
    commits?.current ?? null,
    deployedAt.current,
  );
  insertRelease.run(
    'demo-release-2-3-9',
    'demo-project',
    '2.3.9',
    commits?.previous ?? null,
    deployedAt.previous,
  );

  const events: MonitorEvent[] = [];
  for (let index = 0; index < 96; index += 1) {
    const timestamp = now - (95 - index) * 13 * 60_000;
    const id = `demo-cart-${String(index).padStart(3, '0')}`;
    // 保留一个高频主问题，并把最后 24 条事件分散到 12 个可调查根因中。
    const variantIndex = index >= 72 ? (index - 72) % checkoutFailureVariants.length : -1;
    const variant = variantIndex >= 0 ? checkoutFailureVariants[variantIndex] : undefined;
    const [name, message, functionName] = variant ?? [
      'TypeError',
      `Cannot read properties of undefined (reading 'total') — order ${83000000 + index}`,
      'calculateTotal',
    ];
    // 主问题是 2.4.1 的一次改动引入的（见 demo/repository.ts），只出现在 2.4.1；
    // 次要的根因沿用 baseEvent 的版本分布，两个版本都有。
    const base = baseEvent(id, timestamp, index);
    events.push({
      ...base,
      release: variant ? base.release : '2.4.1',
      eventType: 'error',
      payload: {
        name,
        message,
        stack: `${name}: ${message}\n    at ${functionName} (https://shop.example/assets/checkout.a81e93bd.js:1:${variantIndex >= 0 ? 500 + variantIndex : 420})\n    at submitOrder (https://shop.example/assets/checkout.a81e93bd.js:1:612)`,
        level: 'error',
      },
      breadcrumbs: [
        ...baseEvent(id, timestamp, index).breadcrumbs,
        breadcrumb(
          id,
          4,
          timestamp - 380,
          'error',
          'runtime',
          variant
            ? `${functionName} rejected the checkout state`
            : 'cart.summary was undefined in calculateTotal',
        ),
      ],
    });
  }

  for (let index = 0; index < 42; index += 1) {
    const timestamp = now - (41 - index) * 29 * 60_000;
    const id = `demo-payment-${String(index).padStart(3, '0')}`;
    // 失败的支付请求和页面里之前的请求同属一个 trace，span 是它自己的。
    const payment = { traceId: demoTrace(id).traceId, spanId: demoTrace(id).span('payment') };
    events.push({
      ...baseEvent(id, timestamp, index + 100),
      eventType: 'network',
      payload: {
        method: 'POST',
        url: 'https://api.shop.example/payment/authorize?token=demo',
        status: 503,
        duration: 1820 + index * 9,
        success: false,
        error: 'upstream unavailable',
        ...payment,
      },
      breadcrumbs: [
        ...baseEvent(id, timestamp, index + 100).breadcrumbs,
        breadcrumb(id, 4, timestamp, 'network', 'http', 'POST /payment/authorize → 503', {
          method: 'POST',
          url: 'https://api.shop.example/payment/authorize',
          status: 503,
          duration: 1820 + index * 9,
          ...payment,
        }),
      ],
    });
  }

  for (let index = 0; index < 18; index += 1) {
    const timestamp = now - index * 61 * 60_000;
    const id = `demo-resource-${String(index).padStart(3, '0')}`;
    events.push({
      ...baseEvent(id, timestamp, index + 200),
      eventType: 'resource',
      payload: {
        tagName: 'script',
        resourceType: 'script',
        url: 'https://shop.example/assets/address-lookup.d2b334ac.js',
        message: 'Failed to load address lookup chunk',
      },
    });
  }

  for (let index = 0; index < 11; index += 1) {
    const timestamp = now - index * 77 * 60_000;
    const id = `demo-inventory-${String(index).padStart(3, '0')}`;
    events.push({
      ...baseEvent(id, timestamp, index + 300),
      eventType: 'error',
      payload: {
        name: 'Message',
        message: 'Inventory response omitted warehouseId',
        level: 'warning',
        stack:
          'Message: Inventory response omitted warehouseId\n    at normalizeInventory (https://shop.example/assets/inventory.29ad00ef.js:1:88)',
      },
    });
  }

  const vitalValues = { LCP: 2280, INP: 184, CLS: 0.082, FCP: 1420, TTFB: 620 } as const;
  // web-vitals 归因给出的元素：[偏慢的那个, 较快的那个]。FCP、TTFB 没有元素。
  const vitalTargets: Partial<Record<string, [string, string]>> = {
    LCP: ['main>section.hero>img.hero-banner', 'main>div.product-grid>img.product-thumb'],
    CLS: ['div.promo-banner', 'footer>div.newsletter-signup'],
    INP: ['button#apply-coupon', 'button#pay'],
  };
  let metricIndex = 0;
  for (const [metric, base] of Object.entries(vitalValues)) {
    for (let sample = 0; sample < 28; sample += 1) {
      const id = `demo-vital-${metric}-${sample}`;
      const timestamp = now - sample * 3 * 60 * 60_000;
      const variance = metric === 'CLS' ? sample * 0.0015 : (sample % 7) * 72;
      const targets = vitalTargets[metric];
      const slower = metric === 'CLS' ? sample > 14 : sample % 7 >= 4;
      events.push({
        ...baseEvent(id, timestamp, metricIndex + 400),
        eventType: 'performance',
        payload: {
          metric,
          value: base + variance,
          rating: sample > 23 ? 'needs-improvement' : 'good',
          ...(targets ? { attribution: { target: slower ? targets[0] : targets[1] } } : {}),
        },
        breadcrumbs: [],
        // 指标样本不属于任何 Issue，SDK 不给它们带 trace。
        traceId: undefined,
      });
      metricIndex += 1;
    }
  }

  const sourceMaps = await seedDemoSourceMaps(database, sourceMapDir);
  for (let start = 0; start < events.length; start += 100) {
    // 公共 Schema 规定单个 envelope 最多 100 条，所以按真实限制切批。
    await ingestEnvelope(database, {
      dsnKey: 'demo-dsn-key',
      sentAt: now,
      events: events.slice(start, start + 100),
    });
  }
  return { events: events.length, sourceMaps, repository: commits !== null };
}

/**
 * 两个版本都上传 Source Map。聚合在还原之后进行：某个版本缺 map 时，它的事件只能按压缩后的栈帧聚合，
 * 和有 map 的版本里的同一个 bug 分成两个 Issue（与 Sentry 等产品的行为相同，所以要在构建时上传 map）。
 * 「缺少 map」这种证据缺口由评测集里的 missing-source-map 用例覆盖。
 * 演示数据是虚构的，两个版本用同一份 map（内联的是 2.4.1 的源码）：2.3.9 的 total.ts 与之不同，
 * 但 2.3.9 没有落在那个文件里的事件，展示不到这个差别；按版本读代码以 git 仓库为准。
 */
async function seedDemoSourceMaps(database: TraceDatabase, sourceMapDir: string): Promise<number> {
  let uploaded = 0;
  for (const releaseId of ['demo-release-2-3-9', 'demo-release-2-4-1']) {
    for (const fixture of DEMO_SOURCE_MAPS) {
      await saveSourceMap(
        database,
        sourceMapDir,
        releaseId,
        fixture.minifiedFile,
        Buffer.from(buildSourceMap(fixture)),
      );
      uploaded += 1;
    }
  }
  return uploaded;
}

// 既允许测试 import seedDemoData，也允许 pnpm seed 直接执行；只有后者进入 CLI 分支。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  try {
    const result = await seedDemoData(database, config.sourceMapDir, config.repositoryRoot);
    process.stdout.write(
      `Seeded ${result.events} fictional browser events and ${result.sourceMaps} source maps for demo-project.\n`,
    );
    process.stdout.write(
      result.repository
        ? `Demo git repository: ${config.repositoryRoot}/demo-project (releases point at its commits).\n`
        : 'No demo git repository (git unavailable or REPOSITORY_ROOT is empty): investigations run without the code tools.\n',
    );
  } finally {
    database.close();
  }
}
