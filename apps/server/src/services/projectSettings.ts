import { projectSettingsSchema, type ProjectSettings } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson } from '../lib/json';

/**
 * 没有单独设置过的项目用这一份。扩展和爬虫默认过滤：前者不是应用自己的错误，后者不是真实用户，
 * 两者都会把 Issue 列表和 Web Vitals 带偏。localhost 默认不过滤：本地开发时正需要看到上报。
 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  inboundFilters: {
    browserExtensions: true,
    webCrawlers: true,
    localhost: false,
    errorMessages: [],
    releases: [],
  },
  rateLimit: { eventsPerMinute: null, spikeProtection: true },
};

/**
 * 读项目设置。存的是旧版本写下的、缺了后来新增字段的 JSON 时，缺的字段用默认值补上；
 * 内容损坏（手动改坏、不再通过校验）时整份退回默认值，而不是让接入失败。
 */
export function getProjectSettings(database: TraceDatabase, projectId: string): ProjectSettings {
  const row = database.sqlite
    .prepare('SELECT settings_json FROM projects WHERE id = ?')
    .get(projectId) as { settings_json: string | null } | undefined;
  if (!row?.settings_json) return DEFAULT_PROJECT_SETTINGS;
  const stored = parseJson<Partial<ProjectSettings>>(row.settings_json, {});
  const merged = projectSettingsSchema.safeParse({
    inboundFilters: { ...DEFAULT_PROJECT_SETTINGS.inboundFilters, ...stored.inboundFilters },
    rateLimit: { ...DEFAULT_PROJECT_SETTINGS.rateLimit, ...stored.rateLimit },
  });
  return merged.success ? merged.data : DEFAULT_PROJECT_SETTINGS;
}

/** 整份替换项目设置；项目不存在时返回 false。 */
export function saveProjectSettings(
  database: TraceDatabase,
  projectId: string,
  settings: ProjectSettings,
): boolean {
  const result = database.sqlite
    .prepare('UPDATE projects SET settings_json = ? WHERE id = ?')
    .run(JSON.stringify(settings), projectId);
  return result.changes > 0;
}
