/**
 * 为 SQL 教程生成一个独立的练习库。
 *
 * 表结构与 apps/server/src/db/client.ts 完全一致，因此在这里练熟的 SQL
 * 可以原样用到真实项目上；数据是确定性生成的，任何人重建都得到同一份结果。
 *
 *   node --experimental-sqlite docs/sql-tutorial/seed.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = resolve(here, '.data/sql-playground.db');

/** 固定基准时间，保证每次生成的数据完全一样，教程里的输出才可复现。 */
const BASE = Date.UTC(2026, 2, 2, 9, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, dsn_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
);
CREATE TABLE releases (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL, commit_sha TEXT, created_at INTEGER NOT NULL,
  UNIQUE(project_id, version)
);
CREATE TABLE issues (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  level TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1, user_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, fingerprint)
);
CREATE INDEX issues_project_last_seen ON issues(project_id, last_seen_at);
CREATE TABLE events (
  id TEXT PRIMARY KEY, issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL, type TEXT NOT NULL,
  message TEXT NOT NULL, stack TEXT, original_stack TEXT, page_url TEXT NOT NULL,
  user_id TEXT, context_json TEXT NOT NULL, breadcrumbs_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX events_issue_created ON events(issue_id, created_at);
CREATE INDEX events_issue_user ON events(issue_id, user_id);
CREATE TABLE diagnoses (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  model TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  prompt_version TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(issue_id, input_hash)
);
`;

const projects = [
  ['demo-project', 'Checkout Web', 'demo-dsn-key', BASE - 90 * DAY],
  ['mobile-web', 'Mobile Storefront', 'mobile-dsn-key', BASE - 60 * DAY],
  // 故意留一个没有任何 release / issue 的项目，用来演示 INNER JOIN 与 LEFT JOIN 的区别。
  ['legacy-admin', 'Legacy Admin', 'legacy-dsn-key', BASE - 400 * DAY],
];

const releases = [
  ['rel-2-3-9', 'demo-project', '2.3.9', '7f3ac91', BASE - 21 * DAY],
  ['rel-2-4-0', 'demo-project', '2.4.0', 'b21de40', BASE - 9 * DAY],
  ['rel-2-4-1', 'demo-project', '2.4.1', 'c98fa22', BASE - 2 * DAY],
  // commit_sha 留空，用来演示 NULL 的行为。
  ['rel-m-1-0', 'mobile-web', '1.0.0', null, BASE - 14 * DAY],
];

/**
 * 每个 Issue 声明要生成多少事件，事件本身由下面的确定性规则展开，
 * event_count / user_count 由真实事件回填，不手写，避免计数与明细对不上。
 */
const issueSpecs = [
  {
    id: 'iss-hydrate',
    projectId: 'demo-project',
    fingerprint: 'a1f0c7',
    title: 'CheckoutStateError: Checkout state failed to hydrate',
    status: 'unresolved',
    level: 'error',
    events: 24,
    users: 9,
    releases: ['rel-2-4-1', 'rel-2-4-0'],
  },
  {
    id: 'iss-promotion',
    projectId: 'demo-project',
    fingerprint: 'b73e21',
    title: 'PromotionError: Promotion response contained an invalid discount',
    status: 'unresolved',
    level: 'error',
    events: 15,
    users: 7,
    releases: ['rel-2-4-1'],
  },
  {
    id: 'iss-address',
    projectId: 'demo-project',
    fingerprint: 'c04a95',
    title: 'AddressError: Address validation service returned no candidates',
    status: 'resolved',
    level: 'warning',
    events: 8,
    users: 5,
    releases: ['rel-2-3-9', 'rel-2-4-0'],
  },
  {
    id: 'iss-currency',
    projectId: 'demo-project',
    fingerprint: 'd52b18',
    title: 'CurrencyError: Currency formatter received a non-numeric total',
    status: 'unresolved',
    level: 'warning',
    events: 6,
    users: 4,
    releases: ['rel-2-4-1'],
  },
  {
    id: 'iss-payment',
    projectId: 'demo-project',
    fingerprint: 'e6c330',
    title: 'PaymentMountError: Payment method component failed to mount',
    status: 'ignored',
    level: 'error',
    events: 3,
    users: 2,
    releases: ['rel-2-3-9'],
  },
  {
    // 一条事件都没有的 Issue：LEFT JOIN 与 INNER JOIN 的差异全靠它体现。
    id: 'iss-tax',
    projectId: 'demo-project',
    fingerprint: 'f18d47',
    title: 'TaxError: Tax estimate request exceeded its deadline',
    status: 'unresolved',
    level: 'error',
    events: 0,
    users: 0,
    releases: [],
  },
  {
    id: 'iss-scroll',
    projectId: 'mobile-web',
    fingerprint: '0a9e63',
    title: 'ScrollError: Virtual list scroll anchor was lost',
    status: 'unresolved',
    level: 'warning',
    events: 5,
    users: 3,
    releases: ['rel-m-1-0'],
  },
  {
    id: 'iss-auth',
    projectId: 'mobile-web',
    fingerprint: '1b4f70',
    title: 'AuthError: Session token refresh returned 401',
    status: 'resolved',
    level: 'error',
    events: 4,
    users: 3,
    releases: ['rel-m-1-0'],
  },
];

const routes = ['/checkout', '/checkout/review', '/cart', '/checkout/payment'];
const browsers = ['Chrome/132.0', 'Edg/131.0', 'Safari/18.2', 'Firefox/134.0'];

function buildEvents() {
  const rows = [];
  let n = 0;
  for (const spec of issueSpecs) {
    for (let i = 0; i < spec.events; i += 1) {
      n += 1;
      const route = routes[i % routes.length];
      // 用户在 users 个候选里轮转，因此 distinct user 数正好等于 spec.users。
      const userId = `customer-${(i % spec.users) + 1}`;
      const releaseId = spec.releases[i % spec.releases.length];
      // 事件从近到远铺开，越靠前的事件越新。
      const createdAt = BASE - i * 5 * HOUR - (spec.events - i) * 900_000;
      const [type, message] = spec.title.split(': ');
      rows.push([
        `evt-${String(n).padStart(3, '0')}`,
        spec.id,
        releaseId,
        type,
        message,
        `at ${type.toLowerCase()}Handler (checkout.js:${120 + i})`,
        null,
        `https://shop.example${route}?session=demo-${i}`,
        userId,
        JSON.stringify({
          browser: browsers[i % browsers.length],
          viewport: i % 4 === 0 ? '390x844' : '1440x900',
        }),
        JSON.stringify([{ type: 'click', message: 'button.checkout-step' }]),
        createdAt,
      ]);
    }
  }
  // 两条不属于任何 Issue 的孤儿事件：教 NULL 与 LEFT JOIN 反向查询。
  for (let i = 0; i < 2; i += 1) {
    n += 1;
    rows.push([
      `evt-${String(n).padStart(3, '0')}`,
      null,
      'rel-2-4-1',
      'UnknownError',
      'Unclassified runtime failure',
      null,
      null,
      'https://shop.example/checkout',
      null,
      JSON.stringify({ browser: 'Chrome/132.0' }),
      JSON.stringify([]),
      BASE - (i + 1) * 3 * HOUR,
    ]);
  }
  return rows;
}

const diagnoses = [
  [
    'dia-1',
    'iss-hydrate',
    'gpt-5.6-terra',
    'h1',
    '{"summary":"State hydration race"}',
    'v3',
    1820,
    640,
    4210,
    BASE - 1 * DAY,
  ],
  [
    'dia-2',
    'iss-hydrate',
    'gpt-5.6-terra',
    'h2',
    '{"summary":"Refined analysis"}',
    'v3',
    1910,
    705,
    3980,
    BASE - 6 * HOUR,
  ],
  [
    'dia-3',
    'iss-promotion',
    'gpt-5.6-terra',
    'p1',
    '{"summary":"Discount parsing"}',
    'v3',
    1240,
    510,
    5120,
    BASE - 2 * DAY,
  ],
  [
    'dia-4',
    'iss-address',
    'local-evidence',
    'a1',
    '{"summary":"Upstream timeout"}',
    'v2',
    0,
    0,
    45,
    BASE - 5 * DAY,
  ],
];

export function seed() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });

  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);

  const insertProject = db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)');
  for (const row of projects) insertProject.run(...row);

  const insertRelease = db.prepare('INSERT INTO releases VALUES (?, ?, ?, ?, ?)');
  for (const row of releases) insertRelease.run(...row);

  const eventRows = buildEvents();

  const insertIssue = db.prepare('INSERT INTO issues VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const spec of issueSpecs) {
    const mine = eventRows.filter((row) => row[1] === spec.id);
    const times = mine.map((row) => row[11]);
    const users = new Set(mine.map((row) => row[8]));
    insertIssue.run(
      spec.id,
      spec.projectId,
      spec.fingerprint,
      spec.title,
      spec.status,
      spec.level,
      times.length ? Math.min(...times) : BASE - 30 * DAY,
      times.length ? Math.max(...times) : BASE - 30 * DAY,
      mine.length,
      users.size,
    );
  }

  const insertEvent = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of eventRows) insertEvent.run(...row);

  const insertDiagnosis = db.prepare('INSERT INTO diagnoses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of diagnoses) insertDiagnosis.run(...row);

  const counts = {
    projects: projects.length,
    releases: releases.length,
    issues: issueSpecs.length,
    events: eventRows.length,
    diagnoses: diagnoses.length,
  };
  db.close();
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = seed();
  console.log(`练习库已生成：${DB_PATH}`);
  console.log(
    Object.entries(counts)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n'),
  );
  console.log(
    '\n试试：node --experimental-sqlite docs/sql-tutorial/q.mjs "SELECT * FROM projects"',
  );
}
