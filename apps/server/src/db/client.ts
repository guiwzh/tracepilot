import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { browserName } from '../lib/userAgent';
import { migrate } from './migrations';

/**
 * 数据库连接。表结构和它的历次变更见 migrations.ts。
 *
 * 所有查询都是手写 SQL，一律用 prepare + 参数占位符（?）：用户输入作为参数传入、不拼进 SQL 字符串，
 * 杜绝 SQL 注入。曾经还并存一套 Drizzle 的表结构描述，只服务四条写入语句，却要和建表语句手工保持同步。
 */
export interface TraceDatabase {
  sqlite: BetterSqlite3.Database;
  close(): void;
}

/**
 * 打开（不存在则创建）数据库文件并升级到最新结构。整个进程只调用一次，所有请求共用这个连接。
 *
 * better-sqlite3 的接口是同步的：一条 SQL 执行完才返回，不需要 await。这听起来会阻塞 Node 的事件循环，
 * 但本地文件上的单条查询通常在一毫秒以内，比起异步驱动来回调度的开销反而更省。
 * 换成 PostgreSQL 这类网络数据库时，就必须改用异步接口。
 */
export function createDatabase(databasePath: string): TraceDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new BetterSqlite3(databasePath);
  // 另一个连接正在写时，最多等 5 秒再报「数据库被锁」，而不是立刻失败。
  sqlite.pragma('busy_timeout = 5000');
  // SQLite 默认不检查外键，需要在每个连接上显式打开，建表语句里的 REFERENCES 约束才会生效。
  sqlite.pragma('foreign_keys = ON');
  // WAL（预写日志）模式：写操作先追加到日志文件，读请求不会被写操作阻塞。
  sqlite.pragma('journal_mode = WAL');
  // 把 JS 函数注册成 SQL 函数，SQL 里写 browser_name(ua) 就调用它：浏览器分类规则只有 lib/userAgent.ts 一份。
  // deterministic 告诉 SQLite 同样的输入总得到同样的结果，允许它做相应的优化。
  sqlite.function('browser_name', { deterministic: true }, (userAgent: unknown) =>
    browserName(typeof userAgent === 'string' ? userAgent : ''),
  );
  try {
    migrate(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { sqlite, close: () => sqlite.close() };
}

/**
 * 以只读方式打开已有的数据库：MCP 的 stdio 进程用（mcp/stdio.ts）。
 *
 * query_only 让这个连接上的任何写语句都直接报错：即使工具代码有 bug、或者以后加错了工具，
 * 这个进程也改不了数据。不用 better-sqlite3 的 readonly 打开方式：WAL 模式的数据库在没有 -shm 文件时
 * （服务端没在运行）只读打开会失败。
 * 不执行迁移：结构比代码旧或新都拒绝打开，让用户先用新版本的服务端启动一次完成升级。
 */
export function openReadOnlyDatabase(databasePath: string, expectedVersion: number): TraceDatabase {
  const sqlite = new BetterSqlite3(databasePath, { fileMustExist: true });
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('query_only = ON');
  sqlite.function('browser_name', { deterministic: true }, (userAgent: unknown) =>
    browserName(typeof userAgent === 'string' ? userAgent : ''),
  );
  const version = sqlite.pragma('user_version', { simple: true }) as number;
  if (version !== expectedVersion) {
    sqlite.close();
    throw new Error(
      `The database is at schema version ${version}, but this code expects ${expectedVersion}. ` +
        'Start the TracePilot server once to migrate it.',
    );
  }
  return { sqlite, close: () => sqlite.close() };
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
