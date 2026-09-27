import 'dotenv/config';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';
import { loadConfig } from './config';
import { createDatabase, ensureDemoProject, type TraceDatabase } from './db/client';
import { buildSourceMap, DEMO_SOURCE_MAPS } from './demo/sourceMaps';
import { ingestEnvelope } from './services/events';
import { saveSourceMap } from './services/sourcemaps';

/**
 * 演示数据脚本（pnpm seed）：清空并重建 demo-project 的虚构数据，外加两份 Source Map。
 *
 * 通过正式的 ingestEnvelope 写入虚构事件，而不是直接往 issues 表插最终结果，
 * 因此演示数据也会经过指纹、脱敏、聚合和计数的真实生产代码。
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

function baseEvent(
  id: string,
  timestamp: number,
  index: number,
): Omit<MonitorEvent, 'eventType' | 'payload'> {
  const route = index % 4 === 0 ? '/checkout/review' : index % 3 === 0 ? '/cart' : '/checkout';
  return {
    eventId: id,
    timestamp,
    projectId: 'demo-project',
    release: index % 7 === 0 ? '2.3.9' : '2.4.1',
    environment: 'production',
    page: { url: `https://shop.example${route}?session=demo-${index}`, route, title: 'Checkout' },
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
        },
      ),
    ],
  };
}

export function seedDemoData(database: TraceDatabase): { events: number } {
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
  database.sqlite
    .prepare(
      'INSERT INTO releases (id, project_id, version, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('demo-release-2-4-1', 'demo-project', '2.4.1', '7f3ac91', now - 3_600_000);
  database.sqlite
    .prepare(
      'INSERT INTO releases (id, project_id, version, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('demo-release-2-3-9', 'demo-project', '2.3.9', '4b2e210', now - 5 * 24 * 3_600_000);

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
    events.push({
      ...baseEvent(id, timestamp, index),
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
      },
      breadcrumbs: [
        ...baseEvent(id, timestamp, index + 100).breadcrumbs,
        breadcrumb(id, 4, timestamp, 'network', 'http', 'POST /payment/authorize → 503', {
          method: 'POST',
          url: 'https://api.shop.example/payment/authorize',
          status: 503,
          duration: 1820 + index * 9,
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
  let metricIndex = 0;
  for (const [metric, base] of Object.entries(vitalValues)) {
    for (let sample = 0; sample < 28; sample += 1) {
      const id = `demo-vital-${metric}-${sample}`;
      const timestamp = now - sample * 3 * 60 * 60_000;
      const variance = metric === 'CLS' ? sample * 0.0015 : (sample % 7) * 72;
      events.push({
        ...baseEvent(id, timestamp, metricIndex + 400),
        eventType: 'performance',
        payload: {
          metric,
          value: base + variance,
          rating: sample > 23 ? 'needs-improvement' : 'good',
        },
        breadcrumbs: [],
      });
      metricIndex += 1;
    }
  }

  for (let start = 0; start < events.length; start += 100) {
    // 公共 Schema 规定单个 envelope 最多 100 条，所以按真实限制切批。
    ingestEnvelope(database, {
      dsnKey: 'demo-dsn-key',
      sentAt: now,
      events: events.slice(start, start + 100),
    });
  }
  return { events: events.length };
}

/**
 * 只给 2.4.1 上传 Source Map，2.3.9 故意不传：调查时既能看到还原后的源码，
 * 也能遇到「该版本缺少 map」这种真实会发生的证据缺口。
 * 上传走正式的 saveSourceMap，会顺带回填该 Release 里引用了这个文件的已有事件的原始堆栈。
 */
export async function seedDemoSourceMaps(
  database: TraceDatabase,
  sourceMapDir: string,
): Promise<number> {
  for (const fixture of DEMO_SOURCE_MAPS) {
    await saveSourceMap(
      database,
      sourceMapDir,
      'demo-release-2-4-1',
      fixture.minifiedFile,
      Buffer.from(buildSourceMap(fixture)),
    );
  }
  return DEMO_SOURCE_MAPS.length;
}

// 既允许测试 import seedDemoData，也允许 pnpm seed 直接执行；只有后者进入 CLI 分支。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  try {
    const result = seedDemoData(database);
    const maps = await seedDemoSourceMaps(database, config.sourceMapDir);
    process.stdout.write(
      `Seeded ${result.events} fictional browser events and ${maps} source maps for demo-project.\n`,
    );
  } finally {
    database.close();
  }
}
