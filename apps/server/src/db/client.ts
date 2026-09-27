import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

/**
 * 数据库结构（建表语句）。SQLite 把整个数据库存成一个本地文件，不需要单独的数据库服务，
 * 所以 `pnpm dev` 不依赖 Docker。
 *
 * 表之间的关系（→ 表示「属于」）：
 *
 *   projects                    一个接入 SDK 的前端应用
 *     ├─ releases → projects    应用的一个发布版本（2.4.1 等），Source Map 按版本隔离
 *     │    └─ source_maps       该版本上传的 .map 文件登记（文件本体存在磁盘目录里）
 *     └─ issues → projects      按「错误指纹」聚合出的一类问题，列表页的一行
 *          ├─ events            一次具体发生（一条浏览器上报），同时关联到它所在的 release
 *          ├─ diagnoses         单次诊断的结果缓存
 *          └─ investigation_runs → investigation_events   排障 Agent 的一次调查及其完整事件流
 *
 * 约定：
 * - 时间一律存毫秒时间戳（INTEGER），和前端的 Date.now() 同一口径。
 * - 结构多变的数据（事件上下文、breadcrumb、报告）序列化成 JSON 存进 TEXT 列，读出时再解析。
 * - REFERENCES 是外键：ON DELETE CASCADE 表示父记录删除时子记录一起删（删项目 → 删它的 Issue）；
 *   ON DELETE SET NULL 表示只断开关联、保留子记录（删 Issue 时事件本身留下）。
 * - UNIQUE 约束是最后一道防重：即使代码有 bug，数据库也不允许同一项目出现两个相同指纹的 Issue。
 *
 * 用 IF NOT EXISTS 让这段语句每次启动都可以安全重复执行。代价是它只能「新增」表和索引，
 * 改已有表的结构（加列、改类型）需要版本化的迁移脚本，那是走向正式部署时要补的。
 */
const INITIAL_SCHEMA = `
-- SQLite 默认不检查外键，需要显式打开，上面的 REFERENCES 约束才会生效。
PRAGMA foreign_keys = ON;
-- WAL（预写日志）模式：写操作先追加到日志文件，读请求不会被写操作阻塞。
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, dsn_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL, commit_sha TEXT, created_at INTEGER NOT NULL,
  UNIQUE(project_id, version)
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  level TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0, user_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, fingerprint)
);
-- 索引相当于按某几列预先排好序的目录：查询条件和排序正好命中索引时，数据库不必扫描整张表。
-- 这一个服务于 Issue 列表「按项目筛选、按最后出现时间排序」。
CREATE INDEX IF NOT EXISTS issues_project_last_seen ON issues(project_id, last_seen_at);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL, type TEXT NOT NULL,
  message TEXT NOT NULL, stack TEXT, original_stack TEXT, page_url TEXT NOT NULL,
  user_id TEXT, context_json TEXT NOT NULL, breadcrumbs_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
-- Issue 详情页取「某个 Issue 最近的事件」。
CREATE INDEX IF NOT EXISTS events_issue_created ON events(issue_id, created_at);
-- 上传 Source Map 后回填「某个版本的全部事件」。
CREATE INDEX IF NOT EXISTS events_release ON events(release_id);
-- 概览页按时间窗口统计事件。
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
-- 支撑接入时“该用户是否已在此 Issue 出现过”的判定，使 user_count 增量更新与事件数无关。
CREATE INDEX IF NOT EXISTS events_issue_user ON events(issue_id, user_id);
CREATE TABLE IF NOT EXISTS source_maps (
  id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  minified_file TEXT NOT NULL, map_path TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(release_id, minified_file)
);
CREATE TABLE IF NOT EXISTS diagnoses (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  model TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  prompt_version TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(issue_id, input_hash)
);
CREATE INDEX IF NOT EXISTS diagnoses_issue_created ON diagnoses(issue_id, created_at);
CREATE TABLE IF NOT EXISTS investigation_runs (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  status TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  report_json TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS investigation_runs_issue ON investigation_runs(issue_id, started_at);
-- 每次运行的完整事件流。SSE 断线重连时按 seq 回放，页面刷新后也能看到完整的调查过程。
-- 主键是 (run_id, seq) 两列的组合：同一次运行里 seq 不能重复。
CREATE TABLE IF NOT EXISTS investigation_events (
  run_id TEXT NOT NULL REFERENCES investigation_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`;

export type TraceDatabase = ReturnType<typeof createDatabase>;

/**
 * 打开（不存在则创建）数据库文件并确保表结构存在。整个进程只调用一次，所有请求共用这个连接。
 *
 * better-sqlite3 的接口是同步的：一条 SQL 执行完才返回，不需要 await。这听起来会阻塞 Node 的事件循环，
 * 但本地文件上的单条查询通常在一毫秒以内，比起异步驱动来回调度的开销反而更省。
 * 换成 PostgreSQL 这类网络数据库时，就必须改用异步接口。
 */
export function createDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new BetterSqlite3(databasePath);
  // 另一个连接正在写时，最多等 5 秒再报「数据库被锁」，而不是立刻失败。
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(INITIAL_SCHEMA);
  // 两种访问方式并存：Drizzle（带 TypeScript 类型的查询构造器）用于简单的增改，
  // 手写 SQL 用于复杂的聚合查询。手写 SQL 一律用 prepare + 参数占位符（?），
  // 用户输入作为参数传入、不拼进 SQL 字符串，杜绝 SQL 注入。
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

export function ensureDemoProject(database: TraceDatabase): void {
  // ON CONFLICT DO NOTHING：主键或唯一键已存在时什么都不做。
  // 这样每次启动都能保证演示项目存在，又不会覆盖已经产生的数据。
  const now = Date.now();
  database.sqlite
    .prepare(
      `INSERT INTO projects (id, name, dsn_key, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run('demo-project', 'Checkout Web', 'demo-dsn-key', now);
  database.sqlite
    .prepare(
      `INSERT INTO releases (id, project_id, version, commit_sha, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, version) DO NOTHING`,
    )
    .run('demo-release-2-4-1', 'demo-project', '2.4.1', '7f3ac91', now - 3_600_000);
}
