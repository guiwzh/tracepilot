import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ApiToken, CreatedApiToken } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';

/**
 * 项目级的只读 API 令牌，给 MCP 客户端（Claude Code、Cursor 等）访问 /mcp 用。
 *
 * - 令牌是 tp_ 加 24 字节随机数（base64url），明文只在创建时返回一次；数据库只存 SHA-256。
 * - 按哈希查找（唯一索引），不是取出所有令牌逐个比较：比较的是攻击者无法控制前缀的哈希值，
 *   不存在按字符逐位猜测的时序侧信道。
 * - 令牌只授予「读这个项目」：MCP 工具全部只读，所以没有单独的权限范围字段。
 */

const TOKEN_PREFIX = 'tp_';
/** last_used_at 至多每分钟写一次：每个 MCP 请求都写一次库，只为了更新一个展示用的时间，不值得。 */
const TOUCH_INTERVAL_MS = 60_000;

interface Row {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toRecord(row: Row): ApiToken {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function createApiToken(
  database: TraceDatabase,
  projectId: string,
  name: string,
  now = Date.now(),
): CreatedApiToken {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  const row: Row = {
    id: randomUUID(),
    project_id: projectId,
    name,
    prefix: token.slice(0, 10),
    created_at: now,
    last_used_at: null,
  };
  database.sqlite
    .prepare(
      `INSERT INTO api_tokens (id, project_id, name, token_hash, prefix, created_at)
       VALUES (@id, @project_id, @name, @hash, @prefix, @created_at)`,
    )
    .run({ ...row, hash: hashToken(token) });
  return { ...toRecord(row), token };
}

export function listApiTokens(database: TraceDatabase, projectId: string): ApiToken[] {
  const rows = database.sqlite
    .prepare(
      `SELECT id, project_id, name, prefix, created_at, last_used_at FROM api_tokens
       WHERE project_id = ? ORDER BY created_at DESC`,
    )
    .all(projectId) as Row[];
  return rows.map(toRecord);
}

/** 吊销（删除）一个令牌；不存在时返回 false。立即生效：下一个请求就认不出它了。 */
export function revokeApiToken(database: TraceDatabase, tokenId: string): boolean {
  return database.sqlite.prepare('DELETE FROM api_tokens WHERE id = ?').run(tokenId).changes > 0;
}

/** 认出令牌属于哪个项目；认不出返回 null。顺便记下最近一次使用的时间。 */
export function authenticateApiToken(
  database: TraceDatabase,
  token: string,
  now = Date.now(),
): { tokenId: string; projectId: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = database.sqlite
    .prepare('SELECT id, project_id, last_used_at FROM api_tokens WHERE token_hash = ?')
    .get(hashToken(token)) as
    { id: string; project_id: string; last_used_at: number | null } | undefined;
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > TOUCH_INTERVAL_MS) {
    database.sqlite.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  return { tokenId: row.id, projectId: row.project_id };
}
