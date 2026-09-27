import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SourceMapConsumer, type RawSourceMap } from 'source-map';
import { redactSensitive, redactStack, type SourceMapRecord } from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { SourceMapCache } from './sourceMapCache';

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

/** 上传的文件不是可用的 Source Map。路由据此返回 400，其余错误（例如磁盘写入失败）按 500 处理。 */
export class InvalidSourceMapError extends Error {
  constructor(reason: string) {
    super(`INVALID_SOURCE_MAP: ${reason}`);
  }
}

/**
 * 读取并解析一份已登记的 map。读不到或解析失败（文件被清理、内容损坏）时返回 null：
 * 调用方把它当作「没有 map」处理，保留压缩位置，而不是让整次接入或回填失败。
 */
async function loadConsumer(
  mapPath: string,
): Promise<{ value: SourceMapConsumer; bytes: number } | null> {
  try {
    const content = await readFile(mapPath);
    const rawMap = JSON.parse(content.toString('utf8')) as RawSourceMap;
    return { value: await new SourceMapConsumer(rawMap), bytes: content.length };
  } catch {
    return null;
  }
}

/**
 * 全进程共用的解析结果缓存，见 sourceMapCache.ts。预算按 map 原始大小计：32 MB 大约能同时放下
 * 四份 8 MB 的大型 map，解析后约占 150 MB 内存。
 */
const consumers = new SourceMapCache(loadConsumer, {
  budgetBytes: 32 * 1024 * 1024,
  maxEntries: 64,
});

/** 释放全部已解析的 map；应用关闭时调用。 */
export function clearSourceMapCache(): void {
  consumers.clear();
}

/**
 * 校验上传的内容确实是一份可用的 Source Map，返回已经完整解析过的 Consumer。
 *
 * 只构造 Consumer 不够：source-map 库在第一次查询时才解码 mappings。字段齐全、mappings 却已损坏的 map
 * （例如 "AAAA;!!!!"，或引用了不存在的 sources 下标）会在构造时通过、在查询时抛错。
 * 曾经这样的 map 上传返回 201，之后该版本每一次接入都返回 500。所以这里把每一条映射都走一遍。
 */
async function parseSourceMap(content: Buffer): Promise<SourceMapConsumer> {
  let parsed: Partial<RawSourceMap>;
  try {
    parsed = JSON.parse(content.toString('utf8')) as Partial<RawSourceMap>;
  } catch {
    throw new InvalidSourceMapError('not JSON');
  }
  if (parsed.version !== 3 || typeof parsed.mappings !== 'string') {
    throw new InvalidSourceMapError('not a version 3 source map');
  }
  let consumer: SourceMapConsumer;
  try {
    consumer = await new SourceMapConsumer(parsed as RawSourceMap);
  } catch {
    throw new InvalidSourceMapError('the map cannot be parsed');
  }
  try {
    // 8 MB、68 万条映射的 map 约 60 ms；解码结果留在 Consumer 里，回填直接复用。
    consumer.eachMapping(() => {});
    return consumer;
  } catch {
    consumer.destroy();
    throw new InvalidSourceMapError('mappings cannot be decoded');
  }
}

/**
 * map 文件的位置由「版本 + 文件名」决定：同一份文件的两次并发上传写的是同一个路径，
 * 最后一次改名生效，不会留下数据库不再引用的孤儿文件。
 */
function mapFilePath(sourceMapDir: string, releaseId: string, minifiedFile: string): string {
  const key = createHash('sha256').update(`${releaseId}\0${minifiedFile}`).digest('hex');
  return join(sourceMapDir, `${key.slice(0, 32)}.map`);
}

/**
 * 先写到临时文件再改名：rename 在同一文件系统内是原子的，并发读取的一方
 * 要么读到旧的完整文件、要么读到新的完整文件，不会读到写了一半的内容。
 */
async function writeFileAtomically(path: string, content: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    // mode 0o600 是 Unix 文件权限：只有运行服务的系统用户能读写，同机其他用户读不到源码。
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * 保存一份上传的 Source Map：完整校验 → 原子写入磁盘 → 在数据库登记 → 回填引用了这个文件的历史事件。
 * 同一版本重复上传同名文件时覆盖旧文件，而不是新增一份。
 */
export async function saveSourceMap(
  database: TraceDatabase,
  sourceMapDir: string,
  releaseId: string,
  minifiedFile: string,
  content: Buffer,
): Promise<SourceMapRecord> {
  // 校验失败时什么都还没写：文件、数据库和缓存都保持原样。
  const consumer = await parseSourceMap(content);
  const normalized = normalizeMinifiedFile(minifiedFile);
  const existing = database.sqlite
    .prepare('SELECT map_path FROM source_maps WHERE release_id = ? AND minified_file = ?')
    .get(releaseId, normalized) as { map_path: string } | undefined;
  // 已上传过就沿用原来的文件路径（包括本规则之前按 id 命名的旧文件），新内容覆盖旧文件。
  const mapPath = existing?.map_path ?? mapFilePath(sourceMapDir, releaseId, normalized);
  const now = Date.now();
  let row: { id: string };
  try {
    await mkdir(sourceMapDir, { recursive: true });
    // 文件本体放磁盘，数据库只记路径：数据库行保持小巧，大文件也不必整个读进 SQL。
    await writeFileAtomically(mapPath, content);
    // 「upsert」（有则更新、无则插入）：UNIQUE(release_id, minified_file) 冲突时改走 DO UPDATE，
    // excluded 指这次本想插入的那一行。RETURNING 取回真正留在库里的 id：并发上传时
    // 后到的一方走的是更新分支，它自己生成的 id 并没有写进去。
    row = database.sqlite
      .prepare(
        `INSERT INTO source_maps (id, release_id, minified_file, map_path, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(release_id, minified_file) DO UPDATE SET map_path = excluded.map_path, created_at = excluded.created_at
         RETURNING id`,
      )
      .get(randomUUID(), releaseId, normalized, mapPath, now) as { id: string };
  } catch (error) {
    consumer.destroy();
    // 文件可能已经被新内容覆盖，缓存里的旧解析结果不能再用。
    consumers.invalidate(mapPath);
    throw error;
  }
  // 校验时已经完整解析过，直接放进缓存替换旧版本，回填不必再解析一遍。
  consumers.replace(mapPath, consumer, content.length);
  // 回填：常见顺序是「先发版、线上报错、再补传 map」，上传后立即把该版本已有的事件还原一遍，
  // 不必等新的错误发生才能看到源码栈。
  await symbolicateReleaseEvents(database, releaseId, normalized);
  return { id: row.id, releaseId, minifiedFile: normalized, createdAt: now };
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

/** 一帧在源码里的位置；映射不到时为 null。 */
interface OriginalPosition {
  /** 去掉了查询参数的源文件名，用于展示。 */
  source: string;
  /** map 里记录的原样文件名，按它查 sourcesContent。 */
  rawSource: string;
  line: number;
  /** 0 基，和 source-map 库一致。 */
  column: number;
  name: string | null;
}

function originalPosition(consumer: SourceMapConsumer, frame: StackFrame): OriginalPosition | null {
  // 浏览器列号从 1 开始，source-map 库列号从 0 开始；读写时各转换一次。
  const original = consumer.originalPositionFor({
    line: frame.lineNumber,
    column: Math.max(0, frame.columnNumber - 1),
  });
  if (!original.source || original.line == null || original.column == null) return null;
  return {
    source: original.source.replace(/[?#].*$/, ''),
    rawSource: original.source,
    line: original.line,
    column: original.column,
    name: original.name,
  };
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
  const findMap = database.sqlite.prepare(
    'SELECT map_path FROM source_maps WHERE release_id = ? AND minified_file = ?',
  );
  let mapped = 0;
  const result: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = parseStackFrame(line);
    const row = frame
      ? (findMap.get(releaseId, normalizeMinifiedFile(frame.file)) as
          { map_path: string } | undefined)
      : undefined;
    // 同一份 map 在缓存里只解析一次；同一堆栈的多帧、同一批的多个事件都复用它。
    const original =
      frame && row
        ? await consumers.use(row.map_path, (consumer) => originalPosition(consumer, frame))
        : null;
    if (frame && original) {
      const fn = original.name ?? frame.functionName ?? '<anonymous>';
      result.push(`    at ${fn} (${original.source}:${original.line}:${original.column + 1})`);
      mapped += 1;
    } else {
      result.push(line);
    }
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

  // 登记了但读不到（文件被清理或损坏），对调查来说就是缺少 map。
  const result = await consumers.use(row.map_path, (consumer): SourceContextResult => {
    const original = originalPosition(consumer, frame);
    if (!original) return { ok: false, reason: 'FRAME_NOT_MAPPED' };
    const content = consumer.sourceContentFor(original.rawSource, true);
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
    return {
      ok: true,
      location: `${original.source}:${original.line}:${original.column + 1}`,
      functionName: original.name ?? frame.functionName ?? null,
      // 源码里偶尔有硬编码的令牌，发给模型前同样过一遍脱敏。
      snippet: redactSensitive(snippet),
    };
  });
  return result ?? { ok: false, reason: 'NO_SOURCE_MAP' };
}

/** 一个等待还原的事件：入库时刚写入的，或上传 map 后要回填的。 */
export interface StoredStack {
  eventId: string;
  releaseId: string;
  stack: string;
}

/**
 * 逐个还原并写回 events.original_stack，返回还原成功和失败的条数。
 *
 * 单个事件还原失败只计数、不抛出：还原是附加信息，它的失败不能让接入返回 500。
 * 曾经这里一抛错，接入就返回 500，而事件其实已经提交；SDK 把 500 当作可重试，
 * 同一批反复重发、反复失败，这个浏览器之后的事件全部堵在它后面。
 */
export async function symbolicateEvents(
  database: TraceDatabase,
  items: StoredStack[],
): Promise<{ mapped: number; failed: number }> {
  const updates: Array<[string, string]> = [];
  let failed = 0;
  for (const item of items) {
    try {
      const originalStack = await symbolicateStack(database, item.releaseId, item.stack);
      if (originalStack) updates.push([redactStack(originalStack), item.eventId]);
    } catch {
      failed += 1;
    }
  }
  // 结果在一个事务里写回：逐条自动提交时，每条 UPDATE 都要单独落盘一次。
  const update = database.sqlite.prepare('UPDATE events SET original_stack = ? WHERE id = ?');
  database.sqlite.transaction(() => {
    for (const [originalStack, eventId] of updates) update.run(originalStack, eventId);
  })();
  return { mapped: updates.length, failed };
}

/**
 * 用当前已上传的 map 重新还原某个版本的历史事件，返回成功还原的条数。
 * 指定 minifiedFile 时只处理堆栈里出现过这个文件名的事件：上传一个文件的 map，
 * 与它无关的事件不必重算（曾经上传任何 map 都会把整个版本的事件重新还原一遍）。
 */
export async function symbolicateReleaseEvents(
  database: TraceDatabase,
  releaseId: string,
  minifiedFile?: string,
): Promise<number> {
  const rows = (
    minifiedFile
      ? database.sqlite
          .prepare(
            'SELECT id, stack FROM events WHERE release_id = ? AND stack IS NOT NULL AND instr(stack, ?) > 0',
          )
          .all(releaseId, minifiedFile)
      : database.sqlite
          .prepare('SELECT id, stack FROM events WHERE release_id = ? AND stack IS NOT NULL')
          .all(releaseId)
  ) as Array<{ id: string; stack: string }>;
  const { mapped } = await symbolicateEvents(
    database,
    rows.map((row) => ({ eventId: row.id, releaseId, stack: row.stack })),
  );
  return mapped;
}
