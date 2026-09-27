import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * 同一套表结构的 TypeScript 描述，供 Drizzle 使用：写 db.insert(events).values({...}) 时，
 * 列名拼错或类型不对会在编译期报错，而手写 SQL 字符串做不到这一点。
 *
 * 注意它只「描述」表，不负责建表：实际建表由 client.ts 里的 SQL 完成。
 * 改表结构时两处都要改，否则类型和真实的表会对不上。各表的含义见 client.ts 顶部的说明。
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
    eventCount: integer('event_count').notNull().default(0),
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
    // 接入时判定“该用户是否已在此 Issue 出现过”，让 user_count 的增量更新与事件数无关。
    index('events_issue_user').on(table.issueId, table.userId),
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

export const investigationRuns = sqliteTable(
  'investigation_runs',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['running', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    engine: text('engine', { enum: ['model', 'local'] }).notNull(),
    model: text('model').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    steps: integer('steps').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    reportJson: text('report_json'),
    error: text('error'),
  },
  (table) => [index('investigation_runs_issue').on(table.issueId, table.startedAt)],
);

export const investigationEvents = sqliteTable(
  'investigation_events',
  {
    runId: text('run_id')
      .notNull()
      .references(() => investigationRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);
