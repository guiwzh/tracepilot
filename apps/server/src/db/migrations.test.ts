import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import { MIGRATIONS, migrate } from './migrations';

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-migrations-'));
  path = join(directory, 'test.db');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function columns(sqlite: BetterSqlite3.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe('database migrations', () => {
  it('creates a new database at the latest version', () => {
    const database = createDatabase(path);
    expect(database.sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(columns(database.sqlite, 'issues')).toContain('resolved_at');
    database.close();
  });

  it('upgrades a database created before migrations existed and keeps its data', () => {
    // 引入迁移之前的代码只执行建表语句（即 1 号迁移），从不设置 user_version。
    const legacy = new BetterSqlite3(path);
    MIGRATIONS[0]!.up(legacy);
    legacy.exec(`
      INSERT INTO projects VALUES ('p', 'Shop', 'key', 1);
      INSERT INTO issues (id, project_id, fingerprint, title, status, level, first_seen_at, last_seen_at)
        VALUES ('fixed', 'p', 'f1', 'Fixed bug', 'resolved', 'error', 100, 500),
               ('open', 'p', 'f2', 'Open bug', 'unresolved', 'error', 100, 700);
    `);
    legacy.close();

    const database = createDatabase(path);
    expect(database.sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(
      database.sqlite.prepare('SELECT id, status, resolved_at FROM issues ORDER BY id').all(),
    ).toEqual([
      // 不知道确切的解决时间，取最后一次出现的时间：之后再发生就是回归。
      { id: 'fixed', status: 'resolved', resolved_at: 500 },
      { id: 'open', status: 'unresolved', resolved_at: null },
    ]);
    database.close();
  });

  it('runs each migration once', () => {
    createDatabase(path).close();
    const runs: string[] = [];
    const counting = MIGRATIONS.map((migration) => ({
      ...migration,
      up: () => runs.push(migration.description),
    }));
    const sqlite = new BetterSqlite3(path);
    migrate(sqlite, counting);
    sqlite.close();
    expect(runs).toEqual([]);
  });

  it('rolls back a failed migration and names it', () => {
    const sqlite = new BetterSqlite3(path);
    const failing = [
      ...MIGRATIONS,
      {
        description: 'broken change',
        up: (db: BetterSqlite3.Database) => {
          db.exec('CREATE TABLE half_done (id TEXT)');
          throw new Error('boom');
        },
      },
    ];
    expect(() => migrate(sqlite, failing)).toThrow(
      `Database migration ${failing.length} (broken change) failed.`,
    );
    // 前面的迁移都已提交；失败的那个连同它建的表一起撤销，下次启动从它重试。
    expect(sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBe(
      undefined,
    );
    sqlite.close();
  });

  it('refuses to open a database written by a newer server', () => {
    const sqlite = new BetterSqlite3(path);
    sqlite.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    sqlite.close();
    expect(() => createDatabase(path)).toThrow(/only knows/);
  });
});
