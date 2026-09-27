import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SourceMapConsumer, type RawSourceMap } from 'source-map';
import { redactSensitive, type SourceMapRecord } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';

/**
 * Source Map 还原：把线上压缩代码的报错位置翻译回源码位置。
 *
 * 背景：线上跑的是打包压缩后的 app.3f9a.js，报错堆栈长这样：
 *   at t (https://cdn.example.com/assets/app.3f9a.js:1:18234)
 * 行列号指向压缩文件，人看不懂。构建工具（Vite 等）在压缩时可以额外产出 app.3f9a.js.map，
 * 它的 mappings 字段用 Base64 VLQ 编码记录了「压缩文件第几行第几列 ↔ 源码哪个文件第几行第几列」。
 *
 * 流程：
 * 1. 发布时，CI 把 .map 上传到服务端（routes/sourcemaps.ts → saveSourceMap），按 Release 版本隔离保存。
 * 2. 浏览器上报压缩堆栈；服务端按「事件的 Release + 堆栈里的文件名」找到对应的 map，
 *    逐帧换算出源码位置（symbolicateStack），结果存进 events.original_stack。
 *
 * .map 往往内联了完整源码（sourcesContent），所以只存在服务端、不部署到 CDN，也不提供下载接口。
 */

/** 从堆栈的一行里解析出的一帧：哪个文件、第几行第几列、哪个函数。 */
interface StackFrame {
  line: string;
  file: string;
  lineNumber: number;
  columnNumber: number;
  functionName?: string;
}

/** 解析一行堆栈；不是栈帧的行（例如第一行的错误消息）返回 null。 */
export function parseStackFrame(line: string): StackFrame | null {
  // 匹配 V8（Chrome / Node）格式：「at fn (url:line:column)」和没有函数名的「at url:line:column」。
  // 分组依次是：1 函数名（可选）、2 文件 URL、3 行号、4 列号。
  const match = line.match(
    /(?:at\s+([^\s(]+)\s+\()?((?:https?:\/\/|file:\/\/|\/)[^\s)]+):(\d+):(\d+)\)?/,
  );
  if (!match?.[2] || !match[3] || !match[4]) return null;
  return {
    line,
    functionName: match[1],
    file: match[2],
    lineNumber: Number(match[3]),
    columnNumber: Number(match[4]),
  };
}

/**
 * 把文件标识统一成文件名（basename），作为查找 map 的键。
 * 堆栈里是完整 URL（https://cdn.example.com/assets/app.3f9a.js?v=1），上传时填的是 app.3f9a.js，
 * 两者都归一成 app.3f9a.js 才能对上。文件名里带内容哈希，同一版本内不会重名。
 */
export function normalizeMinifiedFile(value: string): string {
  try {
    return basename(new URL(value).pathname);
  } catch {
    return basename(value.split('?')[0] ?? value);
  }
}

/**
 * 保存一份上传的 Source Map：校验 → 写入磁盘 → 在数据库登记 → 回填该版本的历史事件。
 * 同一版本重复上传同名文件时覆盖旧文件，而不是新增一份。
 */
export async function saveSourceMap(
  database: TraceDatabase,
  sourceMapDir: string,
  releaseId: string,
  minifiedFile: string,
  content: Buffer,
): Promise<SourceMapRecord> {
  // 扩展名之外再验证 Source Map v3 的关键字段，拒绝任意 JSON 文件。
  const parsed = JSON.parse(content.toString('utf8')) as Partial<RawSourceMap>;
  if (parsed.version !== 3 || typeof parsed.mappings !== 'string') {
    throw new Error('INVALID_SOURCE_MAP');
  }
  await mkdir(sourceMapDir, { recursive: true });
  const now = Date.now();
  const normalized = normalizeMinifiedFile(minifiedFile);
  const existing = database.sqlite
    .prepare('SELECT id, map_path FROM source_maps WHERE release_id = ? AND minified_file = ?')
    .get(releaseId, normalized) as { id: string; map_path: string } | undefined;
  // 已上传过就复用原来的 id 和文件路径，新内容直接覆盖旧文件。
  const id = existing?.id ?? randomUUID();
  const mapPath = existing?.map_path ?? join(sourceMapDir, `${id}.map`);
  // 文件本体放磁盘，数据库只记路径：数据库行保持小巧，大文件也不必整个读进 SQL。
  // mode 0o600 是 Unix 文件权限：只有运行服务的系统用户能读写，同机其他用户读不到源码。
  await writeFile(mapPath, content, { mode: 0o600 });
  // 「upsert」（有则更新、无则插入）：UNIQUE(release_id, minified_file) 冲突时改走 DO UPDATE，
  // excluded 指这次本想插入的那一行。
  database.sqlite
    .prepare(
      `INSERT INTO source_maps (id, release_id, minified_file, map_path, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(release_id, minified_file) DO UPDATE SET map_path = excluded.map_path, created_at = excluded.created_at`,
    )
    .run(id, releaseId, normalized, mapPath, now);
  // 回填：常见顺序是「先发版、线上报错、再补传 map」，
  // 上传后立即把该版本已有的事件都还原一遍，不必等新的错误发生才能看到源码栈。
  await symbolicateReleaseEvents(database, releaseId);
  return { id, releaseId, minifiedFile: normalized, createdAt: now };
}

export function listSourceMaps(database: TraceDatabase, releaseId: string): SourceMapRecord[] {
  const rows = database.sqlite
    .prepare(
      'SELECT id, release_id, minified_file, created_at FROM source_maps WHERE release_id = ? ORDER BY created_at DESC',
    )
    .all(releaseId) as Array<{
    id: string;
    release_id: string;
    minified_file: string;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    releaseId: row.release_id,
    minifiedFile: row.minified_file,
    createdAt: row.created_at,
  }));
}

/**
 * 把整段压缩堆栈逐帧翻译成源码位置。找不到 map 或映射不到的帧原样保留，
 * 所以结果可能一部分是源码位置、一部分仍是压缩位置。
 */
export async function symbolicateStack(
  database: TraceDatabase,
  releaseId: string,
  stack: string,
): Promise<string | null> {
  const lines = stack.split('\n');
  let mapped = 0;
  const result: string[] = [];
  /**
   * 同一堆栈常包含同一文件的多个 frame，因此缓存的是 Consumer 而不是 map 的 JSON：
   * 真正的开销在解析 mappings（VLQ 解码，source-map 库用 WebAssembly 实现），而不是读文件。
   * 早期实现逐帧调用 SourceMapConsumer.with，10 帧堆栈会把同一份 map 重复解析 10 次。
   */
  const consumers = new Map<string, SourceMapConsumer>();

  try {
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
      let consumer = consumers.get(sourceMapRow.map_path);
      if (!consumer) {
        const rawMap = JSON.parse(await readFile(sourceMapRow.map_path, 'utf8')) as RawSourceMap;
        consumer = await new SourceMapConsumer(rawMap);
        consumers.set(sourceMapRow.map_path, consumer);
      }
      // 浏览器列号从 1 开始，source-map 库列号从 0 开始；读写时各转换一次。
      const original = consumer.originalPositionFor({
        line: frame.lineNumber,
        column: Math.max(0, frame.columnNumber - 1),
      });
      if (original.source && original.line != null && original.column != null) {
        const fn = original.name ?? frame.functionName ?? '<anonymous>';
        const source = original.source.replace(/[?#].*$/, '');
        result.push(`    at ${fn} (${source}:${original.line}:${original.column + 1})`);
        mapped += 1;
      } else {
        result.push(line);
      }
    }
  } finally {
    // Consumer 的数据放在 WebAssembly 内存里，JS 的垃圾回收管不到，必须手动 destroy，
    // 否则回填整个 Release 时内存会持续增长。finally 保证中途抛错也会释放。
    for (const consumer of consumers.values()) consumer.destroy();
  }
  // 一帧都未命中时返回 null，调用方会明确保留压缩堆栈作为降级证据。
  return mapped > 0 ? result.join('\n') : null;
}

export type SourceContextResult =
  | {
      ok: true;
      /** 还原后的位置，形如 src/checkout/total.ts:84:23（列号 1 基）。 */
      location: string;
      functionName: string | null;
      /** 出错行前后若干行源码，出错行以 > 标出。 */
      snippet: string;
    }
  | { ok: false; reason: 'NO_FRAME' | 'NO_SOURCE_MAP' | 'FRAME_NOT_MAPPED' | 'NO_SOURCES_CONTENT' };

/**
 * 读取某个栈帧对应的原始源码片段，供排障 Agent 查看出错行附近的代码。
 *
 * 只有构建时把源码内联进 map（sourcesContent）才能拿到代码；拿不到时如实返回原因，
 * 让调查把它记为缺失信息，而不是中断。片段会发给模型服务商，所以只取出错行前后几行，
 * 并且可以通过配置整体关闭。
 */
export async function sourceContext(
  database: TraceDatabase,
  releaseId: string,
  stack: string,
  frameIndex = 0,
  radius = 5,
): Promise<SourceContextResult> {
  const frames = stack
    .split('\n')
    .map(parseStackFrame)
    .filter((frame): frame is StackFrame => frame !== null);
  const frame = frames[frameIndex];
  if (!frame) return { ok: false, reason: 'NO_FRAME' };
  const row = database.sqlite
    .prepare('SELECT map_path FROM source_maps WHERE release_id = ? AND minified_file = ?')
    .get(releaseId, normalizeMinifiedFile(frame.file)) as { map_path: string } | undefined;
  if (!row) return { ok: false, reason: 'NO_SOURCE_MAP' };

  const rawMap = JSON.parse(await readFile(row.map_path, 'utf8')) as RawSourceMap;
  const consumer = await new SourceMapConsumer(rawMap);
  try {
    // 与 symbolicateStack 相同：浏览器列号 1 基，source-map 库 0 基。
    const original = consumer.originalPositionFor({
      line: frame.lineNumber,
      column: Math.max(0, frame.columnNumber - 1),
    });
    if (!original.source || original.line == null || original.column == null) {
      return { ok: false, reason: 'FRAME_NOT_MAPPED' };
    }
    const content = consumer.sourceContentFor(original.source, true);
    if (!content) return { ok: false, reason: 'NO_SOURCES_CONTENT' };
    const lines = content.split('\n');
    const first = Math.max(1, original.line - radius);
    const last = Math.min(lines.length, original.line + radius);
    const snippet = lines
      .slice(first - 1, last)
      .map((text, offset) => {
        const lineNumber = first + offset;
        return `${lineNumber === original.line ? '>' : ' '} ${String(lineNumber).padStart(4)} | ${text}`;
      })
      .join('\n');
    const source = original.source.replace(/[?#].*$/, '');
    return {
      ok: true,
      location: `${source}:${original.line}:${original.column + 1}`,
      functionName: original.name ?? frame.functionName ?? null,
      // 源码里偶尔有硬编码的令牌，发给模型前同样过一遍脱敏。
      snippet: redactSensitive(snippet),
    };
  } finally {
    consumer.destroy();
  }
}

/** 用当前已上传的 map 重新还原某个版本下所有带堆栈的事件，返回成功还原的条数。 */
export async function symbolicateReleaseEvents(
  database: TraceDatabase,
  releaseId: string,
): Promise<number> {
  const rows = database.sqlite
    .prepare('SELECT id, stack FROM events WHERE release_id = ? AND stack IS NOT NULL')
    .all(releaseId) as Array<{ id: string; stack: string }>;
  let count = 0;
  for (const row of rows) {
    const originalStack = await symbolicateStack(database, releaseId, row.stack);
    if (originalStack) {
      database.sqlite
        .prepare('UPDATE events SET original_stack = ? WHERE id = ?')
        .run(redactSensitive(originalStack), row.id);
      count += 1;
    }
  }
  return count;
}
