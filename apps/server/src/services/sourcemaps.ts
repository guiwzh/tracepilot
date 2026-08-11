import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SourceMapConsumer, type RawSourceMap } from 'source-map';
import type { SourceMapRecord } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';

interface StackFrame {
  line: string;
  file: string;
  lineNumber: number;
  columnNumber: number;
  functionName?: string;
}

function parseStackFrame(line: string): StackFrame | null {
  const match = line.match(/(?:at\s+([^\s(]+)\s+\()?((?:https?:\/\/|file:\/\/|\/)[^\s)]+):(\d+):(\d+)\)?/);
  if (!match?.[2] || !match[3] || !match[4]) return null;
  return {
    line,
    functionName: match[1],
    file: match[2],
    lineNumber: Number(match[3]),
    columnNumber: Number(match[4]),
  };
}

export function normalizeMinifiedFile(value: string): string {
  try {
    return basename(new URL(value).pathname);
  } catch {
    return basename(value.split('?')[0] ?? value);
  }
}

export async function saveSourceMap(
  database: TraceDatabase,
  sourceMapDir: string,
  releaseId: string,
  minifiedFile: string,
  content: Buffer,
): Promise<SourceMapRecord> {
  const parsed = JSON.parse(content.toString('utf8')) as Partial<RawSourceMap>;
  if (parsed.version !== 3 || typeof parsed.mappings !== 'string') {
    throw new Error('INVALID_SOURCE_MAP');
  }
  await mkdir(sourceMapDir, { recursive: true });
  const normalized = normalizeMinifiedFile(minifiedFile);
  const existing = database.sqlite
    .prepare('SELECT id, map_path FROM source_maps WHERE release_id = ? AND minified_file = ?')
    .get(releaseId, normalized) as { id: string; map_path: string } | undefined;
  const id = existing?.id ?? randomUUID();
  const mapPath = existing?.map_path ?? join(sourceMapDir, `${id}.map`);
  await writeFile(mapPath, content, { mode: 0o600 });
  database.sqlite
    .prepare(
      `INSERT INTO source_maps (id, release_id, minified_file, map_path, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(release_id, minified_file) DO UPDATE SET map_path = excluded.map_path, created_at = excluded.created_at`,
    )
    .run(id, releaseId, normalized, mapPath, Date.now());
  await symbolicateReleaseEvents(database, releaseId);
  return { id, releaseId, minifiedFile: normalized, createdAt: Date.now() };
}

export function listSourceMaps(database: TraceDatabase, releaseId: string): SourceMapRecord[] {
  const rows = database.sqlite
    .prepare('SELECT id, release_id, minified_file, created_at FROM source_maps WHERE release_id = ? ORDER BY created_at DESC')
    .all(releaseId) as Array<{ id: string; release_id: string; minified_file: string; created_at: number }>;
  return rows.map((row) => ({
    id: row.id,
    releaseId: row.release_id,
    minifiedFile: row.minified_file,
    createdAt: row.created_at,
  }));
}

export async function symbolicateStack(
  database: TraceDatabase,
  releaseId: string,
  stack: string,
): Promise<string | null> {
  const lines = stack.split('\n');
  let mapped = 0;
  const result: string[] = [];
  const sourceMapCache = new Map<string, RawSourceMap>();

  for (const line of lines) {
    const frame = parseStackFrame(line);
    if (!frame) {
      result.push(line);
      continue;
    }
    const minifiedFile = normalizeMinifiedFile(frame.file);
    const sourceMapRow = database.sqlite
      .prepare('SELECT map_path FROM source_maps WHERE release_id = ? AND minified_file = ?')
      .get(releaseId, minifiedFile) as { map_path: string } | undefined;
    if (!sourceMapRow) {
      result.push(line);
      continue;
    }
    let rawMap = sourceMapCache.get(sourceMapRow.map_path);
    if (!rawMap) {
      rawMap = JSON.parse(await readFile(sourceMapRow.map_path, 'utf8')) as RawSourceMap;
      sourceMapCache.set(sourceMapRow.map_path, rawMap);
    }
    let mappedLine = line;
    await SourceMapConsumer.with(rawMap, null, (consumer) => {
      const original = consumer.originalPositionFor({
        line: frame.lineNumber,
        column: frame.columnNumber,
      });
      if (original.source && original.line != null && original.column != null) {
        const fn = original.name ?? frame.functionName ?? '<anonymous>';
        mappedLine = `    at ${fn} (${original.source}:${original.line}:${original.column})`;
        mapped += 1;
      }
    });
    result.push(mappedLine);
  }
  return mapped > 0 ? result.join('\n') : null;
}

export async function symbolicateReleaseEvents(database: TraceDatabase, releaseId: string): Promise<number> {
  const rows = database.sqlite
    .prepare('SELECT id, stack FROM events WHERE release_id = ? AND stack IS NOT NULL')
    .all(releaseId) as Array<{ id: string; stack: string }>;
  let count = 0;
  for (const row of rows) {
    const originalStack = await symbolicateStack(database, releaseId, row.stack);
    if (originalStack) {
      database.sqlite.prepare('UPDATE events SET original_stack = ? WHERE id = ?').run(originalStack, row.id);
      count += 1;
    }
  }
  return count;
}
