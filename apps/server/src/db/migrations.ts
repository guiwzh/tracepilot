import type BetterSqlite3 from 'better-sqlite3';

/**
 * 数据库结构，以及它的每一次变更。SQLite 把整个数据库存成一个本地文件，不需要单独的数据库服务，
 * 所以 `pnpm dev` 不依赖 Docker。
 *
 * 表之间的关系（→ 表示「属于」）：
 *
 *   projects                    一个接入 SDK 的前端应用
 *     ├─ releases → projects    应用的一个发布版本（2.4.1 等），Source Map 按版本隔离
 *     │    └─ source_maps       该版本上传的 .map 文件登记（文件本体存在磁盘目录里），可带 Debug ID
 *     ├─ ingest_outcomes        每小时的上报去向：收下、被过滤、被限流
 *     ├─ api_tokens             MCP 客户端用的只读令牌（只存哈希）
 *     └─ issues → projects      按「错误指纹」聚合出的一类问题，列表页的一行
 *          ├─ issue_fingerprints 指向这个 Issue 的指纹，一个 Issue 可以有多个（合并、算法升级）
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
  {
    // 指纹与 Issue 解耦，一个 Issue 可以对应多个指纹：合并 Issue 时被合并方的指纹改指向目标；
    // 聚合算法升级时，新算法算出的指纹也登记到原来的 Issue 上，正在发生的问题不会突然变成新 Issue。
    // algorithm 记录指纹出自哪个算法：v1（升级前）、v2（还原后按应用帧）、custom（SDK 自定义）。
    // 已有 Issue 的指纹都是 v1 算的，原样搬进来。
    description: 'issue_fingerprints',
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE issue_fingerprints (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          fingerprint TEXT NOT NULL,
          issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          algorithm TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, fingerprint)
        );
        CREATE INDEX issue_fingerprints_issue ON issue_fingerprints(issue_id);
        INSERT INTO issue_fingerprints (project_id, fingerprint, issue_id, algorithm, created_at)
          SELECT project_id, fingerprint, id, 'v1', first_seen_at FROM issues;
      `);
    },
  },
  {
    // 构建插件给每个产物文件和它的 map 写入同一个 Debug ID，按它找 map 不依赖版本号和文件名。
    // 唯一键从「版本 + 文件名」改为「版本 + 文件名 + Debug ID」：同一个版本号重新构建过、文件名没变
    // 而内容变了时，新旧两份 map 并存，旧页面上报的事件仍按自己的 Debug ID 找到旧 map；
    // 原来的唯一键会让新 map 覆盖旧的。没有 Debug ID 的 map 按空串参与唯一键，行为不变：
    // 同一版本同名文件只留一份，重新上传即替换。
    // SQLite 不能修改已有的约束，只能建新表、搬数据、换名字。没有别的表引用 source_maps。
    // Debug ID 不设全局唯一：同一份内容在两个版本里各上传一次（没改动的 vendor 文件）时它相同。
    description: 'source_maps.debug_id',
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE source_maps_v4 (
          id TEXT PRIMARY KEY,
          release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
          minified_file TEXT NOT NULL,
          debug_id TEXT,
          map_path TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO source_maps_v4 (id, release_id, minified_file, map_path, created_at)
          SELECT id, release_id, minified_file, map_path, created_at FROM source_maps;
        DROP TABLE source_maps;
        ALTER TABLE source_maps_v4 RENAME TO source_maps;
        -- 唯一键，同时服务「版本 + 文件名」的查找（索引的前两列）。
        CREATE UNIQUE INDEX source_maps_release_file
          ON source_maps(release_id, minified_file, COALESCE(debug_id, ''));
        CREATE INDEX source_maps_debug_id ON source_maps(debug_id);
      `);
    },
  },
  {
    // 接入保护：项目设置（入站过滤、限流）存成 JSON，NULL 表示全部用默认值。
    // ingest_outcomes 按小时汇总每个项目的上报去向（收下、被过滤、被限流，及原因），
    // 计数先在内存里累加、每隔几秒写一次（services/outcomes.ts），不是每个请求写一行。
    description: 'project settings and ingest outcomes',
    up: (sqlite) => {
      sqlite.exec(`
        ALTER TABLE projects ADD COLUMN settings_json TEXT;
        CREATE TABLE ingest_outcomes (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          hour INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (project_id, hour, outcome, reason)
        );
      `);
    },
  },
  {
    // MCP 客户端（Claude Code、Cursor 等）用的只读 API 令牌，每个令牌属于一个项目。
    // 只存令牌的 SHA-256：数据库泄露也拿不到能用的令牌。令牌是 192 位随机数，不需要 bcrypt 这类慢哈希
    // （慢哈希防的是低熵的口令被暴力枚举）。按哈希查找走唯一索引。
    description: 'api_tokens',
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE api_tokens (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        );
        CREATE INDEX api_tokens_project ON api_tokens(project_id, created_at);
      `);
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
