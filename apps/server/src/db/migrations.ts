import type BetterSqlite3 from 'better-sqlite3';

/**
 * 数据库结构，以及它的每一次变更。SQLite 把整个数据库存成一个本地文件，不需要单独的数据库服务，
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
 * 迁移怎么工作：数据库文件头里有一个整数 user_version（PRAGMA user_version），记录这个文件已经执行到
 * 第几个迁移。启动时从它之后的迁移依次执行，每个迁移和版本号的更新在同一个事务里提交，
 * 中途失败就整体撤销，下次启动从同一处重试。已经发布的迁移不再修改：改表结构一律追加新的迁移，
 * 否则已经执行过旧版本的数据库永远拿不到改动。
 *
 * 1 号迁移就是引入迁移之前的建表语句，原样保留 IF NOT EXISTS：那时建出的数据库 user_version 为 0，
 * 对它们执行 1 号迁移不会改动任何已有的表，只把版本号记为 1，再接着执行后面的迁移。
 */
export interface Migration {
  /** 一句话说明这次变更，出错时出现在错误信息里。 */
  description: string;
  up(sqlite: BetterSqlite3.Database): void;
}

const INITIAL_SCHEMA = `
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
-- 上传 Source Map 后回填「某个版本的事件」。
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

export const MIGRATIONS: readonly Migration[] = [
  {
    description: 'initial schema',
    up: (sqlite) => sqlite.exec(INITIAL_SCHEMA),
  },
  {
    // 标记为已解决的时间。之后发生的新事件把 Issue 重新打开（回归），更早发生、只是迟到的事件
    // （例如服务端故障期间积压在 SDK 队列里的）不会。之前已解决的 Issue 不知道确切的解决时间，
    // 取它最后一次出现的时间：在那之后再发生，就是回归。
    description: 'issues.resolved_at',
    up: (sqlite) => {
      sqlite.exec('ALTER TABLE issues ADD COLUMN resolved_at INTEGER');
      sqlite.exec("UPDATE issues SET resolved_at = last_seen_at WHERE status = 'resolved'");
    },
  },
];

/** 把数据库升级到最新结构。数据库比这份代码还新时拒绝启动：旧代码不知道新结构的含义，写入可能破坏它。 */
export function migrate(sqlite: BetterSqlite3.Database, migrations = MIGRATIONS): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(
      `The database is at schema version ${current}, but this server only knows ${migrations.length}. ` +
        'Upgrade the server before opening this database.',
    );
  }
  for (let version = current; version < migrations.length; version += 1) {
    const migration = migrations[version]!;
    try {
      sqlite.transaction(() => {
        migration.up(sqlite);
        sqlite.pragma(`user_version = ${version + 1}`);
      })();
    } catch (error) {
      throw new Error(`Database migration ${version + 1} (${migration.description}) failed.`, {
        cause: error,
      });
    }
  }
}
