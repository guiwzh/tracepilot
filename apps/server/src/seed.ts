import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Breadcrumb, MonitorEvent } from '@trace-pilot/shared';
import { loadConfig } from './config';
import { createDatabase, ensureDemoProject, type TraceDatabase } from './db/client';
import { ingestEnvelope } from './services/events';

const browsers = [
  'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/132.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0',
  'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0',
];

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
  database.sqlite.exec(`
    DELETE FROM diagnoses WHERE issue_id IN (SELECT id FROM issues WHERE project_id = 'demo-project');
    DELETE FROM events WHERE issue_id IN (SELECT id FROM issues WHERE project_id = 'demo-project')
      OR release_id IN (SELECT id FROM releases WHERE project_id = 'demo-project');
    DELETE FROM issues WHERE project_id = 'demo-project';
    DELETE FROM releases WHERE project_id = 'demo-project';
  `);
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
    events.push({
      ...baseEvent(id, timestamp, index),
      eventType: 'error',
      payload: {
        name: 'TypeError',
        message: `Cannot read properties of undefined (reading 'total') — order ${83000000 + index}`,
        stack: `TypeError: Cannot read properties of undefined (reading 'total')\n    at calculateTotal (https://shop.example/assets/checkout.a81e93bd.js:1:420)\n    at submitOrder (https://shop.example/assets/checkout.a81e93bd.js:1:612)`,
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
          'cart.summary was undefined in calculateTotal',
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
    ingestEnvelope(database, {
      dsnKey: 'demo-dsn-key',
      sentAt: now,
      events: events.slice(start, start + 100),
    });
  }
  return { events: events.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  try {
    const result = seedDemoData(database);
    process.stdout.write(`Seeded ${result.events} fictional browser events for demo-project.\n`);
  } finally {
    database.close();
  }
}
