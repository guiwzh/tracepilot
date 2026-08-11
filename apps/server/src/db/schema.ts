import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle Schema 为 TypeScript 写入提供列名和类型推导。
 * 当前表的实际创建由 client.ts 中的幂等 DDL 完成，两处结构变更必须保持同步。
 */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  dsnKey: text('dsn_key').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});

export const releases = sqliteTable(
  'releases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    commitSha: text('commit_sha'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('releases_project_version').on(table.projectId, table.version)],
);

export const issues = sqliteTable(
  'issues',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: ['unresolved', 'resolved', 'ignored'] }).notNull(),
    level: text('level', { enum: ['error', 'warning', 'info'] }).notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    eventCount: integer('event_count').notNull().default(1),
    userCount: integer('user_count').notNull().default(0),
  },
  (table) => [
    // 一个项目内相同指纹只能对应一个 Issue，这是事件聚合的数据库级兜底。
    uniqueIndex('issues_project_fingerprint').on(table.projectId, table.fingerprint),
    index('issues_project_last_seen').on(table.projectId, table.lastSeenAt),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    releaseId: text('release_id').references(() => releases.id, { onDelete: 'set null' }),
    type: text('type', { enum: ['error', 'resource', 'network', 'performance'] }).notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    originalStack: text('original_stack'),
    pageUrl: text('page_url').notNull(),
    userId: text('user_id'),
    contextJson: text('context_json').notNull(),
    breadcrumbsJson: text('breadcrumbs_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('events_issue_created').on(table.issueId, table.createdAt),
    index('events_release').on(table.releaseId),
    index('events_created').on(table.createdAt),
  ],
);

export const sourceMaps = sqliteTable(
  'source_maps',
  {
    id: text('id').primaryKey(),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    minifiedFile: text('minified_file').notNull(),
    mapPath: text('map_path').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('source_maps_release_file').on(table.releaseId, table.minifiedFile)],
);

export const diagnoses = sqliteTable(
  'diagnoses',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    inputHash: text('input_hash').notNull(),
    resultJson: text('result_json').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('diagnoses_issue_created').on(table.issueId, table.createdAt),
    // 同一 Issue + 同一证据上下文只存一份诊断，用于幂等缓存。
    uniqueIndex('diagnoses_issue_input').on(table.issueId, table.inputHash),
  ],
);
