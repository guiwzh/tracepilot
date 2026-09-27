import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

/**
 * MVP 使用启动时幂等 DDL，而不是额外迁移服务。
 * IF NOT EXISTS 让开发启动可重复执行；正式演进时应替换为版本化 migration。
 */
const INITIAL_SCHEMA = `
PRAGMA foreign_keys = ON;
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
  event_count INTEGER NOT NULL DEFAULT 1, user_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS issues_project_last_seen ON issues(project_id, last_seen_at);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL, type TEXT NOT NULL,
  message TEXT NOT NULL, stack TEXT, original_stack TEXT, page_url TEXT NOT NULL,
  user_id TEXT, context_json TEXT NOT NULL, breadcrumbs_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_issue_created ON events(issue_id, created_at);
CREATE INDEX IF NOT EXISTS events_release ON events(release_id);
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
CREATE TABLE IF NOT EXISTS investigation_events (
  run_id TEXT NOT NULL REFERENCES investigation_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`;

export type TraceDatabase = ReturnType<typeof createDatabase>;

export function createDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new BetterSqlite3(databasePath);
  // WAL 允许读请求与单个写事务更好地并行；busy_timeout 避免短暂写锁立刻报错。
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(INITIAL_SCHEMA);
  // 保留两种访问面：Drizzle 用于类型安全写入，原生 prepared SQL 用于复杂聚合查询。
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

export function ensureDemoProject(database: TraceDatabase): void {
  // ON CONFLICT DO NOTHING 只保证内置演示项目存在，不会覆盖用户已经产生的数据。
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
