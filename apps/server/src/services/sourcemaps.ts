import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { SourceMapConsumer, type RawSourceMap } from 'source-map';
import {
  DEBUG_ID_PATTERN,
  redactSensitive,
  redactStack,
  type MonitorEvent,
  type SourceMapRecord,
  type StoredEvent,
} from '@trace-pilot/shared';
import type { TraceDatabase } from '../db/client';
import { parseJson } from '../lib/json';
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
 * 1. 构建时，构建插件（packages/vite-plugin）给每个产物文件和它的 map 写入同一个 Debug ID，
 *    把 map 上传到服务端（routes/sourcemaps.ts → saveSourceMap）。手动上传的 map 没有 Debug ID。
 * 2. 浏览器上报压缩堆栈，并带上堆栈里各个文件的 Debug ID（SDK 从插件注入的登记表里查到）。
 *    接入时、聚合之前，服务端逐帧找 map（findMap）：先按 Debug ID，找不到再按「事件的 Release +
 *    文件名」，然后换算出源码位置（resolveStack）。聚合用还原后的栈帧，还原后的堆栈存进 events.original_stack。
 * 3. map 晚于事件上传时，回填已有事件的 original_stack（symbolicateReleaseEvents），但不重新聚合。
 *
 * Debug ID 标识的是「这一份文件内容」。SDK 上报的版本号与上传 map 时填的对不上，按版本 + 文件名
 * 就找不到 map；同一个版本号重新构建过、文件名没变而内容变了（文件名不带内容哈希的构建），
 * 按版本 + 文件名会取到新 map，还原出一个看似合理却错误的位置。按 Debug ID 这两种情况都对。
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
  // 正则没有锚定行首，Firefox / Safari 的「fn@url:line:column」也能取到文件和行列，只是取不到函数名，
  // 还原后用 map 里记录的名字（没有时写 <anonymous>）。
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
 * 校验上传的内容确实是一份可用的 Source Map，返回已经完整解析过的 Consumer，以及 map 里的 Debug ID。
 * Debug ID 字段按 ECMA-426 提案叫 debugId，早期工具写的是 debug_id，两种都认。
 *
 * 只构造 Consumer 不够：source-map 库在第一次查询时才解码 mappings。字段齐全、mappings 却已损坏的 map
 * （例如 "AAAA;!!!!"，或引用了不存在的 sources 下标）会在构造时通过、在查询时抛错。
 * 曾经这样的 map 上传返回 201，之后该版本每一次接入都返回 500。所以这里把每一条映射都走一遍。
 */
async function parseSourceMap(
  content: Buffer,
): Promise<{ consumer: SourceMapConsumer; debugId: string | null }> {
  let parsed: Partial<RawSourceMap> & { debugId?: unknown; debug_id?: unknown };
  try {
    parsed = JSON.parse(content.toString('utf8')) as typeof parsed;
  } catch {
    throw new InvalidSourceMapError('not JSON');
  }
  if (parsed.version !== 3 || typeof parsed.mappings !== 'string') {
    throw new InvalidSourceMapError('not a version 3 source map');
  }
  const declared = parsed.debugId ?? parsed.debug_id;
  const debugId = typeof declared === 'string' ? declared.toLowerCase() : null;
  // 写了却不是 UUID 的 Debug ID 不能静默忽略：产物文件里注入的是同一个值，忽略它，
  // 这份 map 就永远按 Debug ID 找不到，而上传方以为一切正常。
  if (declared !== undefined && !(debugId && DEBUG_ID_PATTERN.test(debugId))) {
    throw new InvalidSourceMapError('debugId is not a UUID');
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
    return { consumer, debugId };
  } catch {
    consumer.destroy();
    throw new InvalidSourceMapError('mappings cannot be decoded');
  }
}

/**
 * 保存一份上传的 Source Map：完整校验 → 写入磁盘 → 在数据库登记 → 回填用得上它的历史事件。
 * 同一版本重复上传同名、同 Debug ID（或都没有 Debug ID）的文件时替换原来的那份，而不是新增一份；
 * 同名而 Debug ID 不同的是另一次构建的产物，两份并存。
 *
 * 每次上传都写一个新文件，写完才让登记指向它，再删掉上一份。正在读取的一方要么还在用旧文件、
 * 要么拿到的已经是完整的新文件，不会读到写了一半的内容；路径从不复用，所以按路径缓存的解析结果
 * 永远对应同一份内容——别的进程（例如 pnpm seed）重新上传后，服务进程也不会继续用旧的解析结果。
 */
export async function saveSourceMap(
  database: TraceDatabase,
  sourceMapDir: string,
  releaseId: string,
  minifiedFile: string,
  content: Buffer,
): Promise<SourceMapRecord> {
  // 校验失败时什么都还没写：文件、数据库和缓存都保持原样。
  const { consumer, debugId } = await parseSourceMap(content);
  const normalized = normalizeMinifiedFile(minifiedFile);
  const mapPath = join(sourceMapDir, `${randomUUID()}.map`);
  const now = Date.now();
  let row: { id: string };
  let previousPath: string | undefined;
  try {
    await mkdir(sourceMapDir, { recursive: true });
    // 文件本体放磁盘，数据库只记路径：数据库行保持小巧，大文件也不必整个读进 SQL。
    // mode 0o600 是 Unix 文件权限：只有运行服务的系统用户能读写，同机其他用户读不到源码。
    await writeFile(mapPath, content, { mode: 0o600 });
    // 查旧记录和改登记在同一段同步代码里完成（better-sqlite3 是同步的，中间不会插进别的请求），
    // 两次并发上传也各自拿到准确的「上一份」，不留孤儿文件。「有则更新、无则插入」常被叫作 upsert；
    // 唯一键里有 COALESCE(debug_id, '') 表达式，这里按 IS 比较（NULL IS NULL 为真）自己判断。
    const previous = database.sqlite
      .prepare(
        'SELECT id, map_path FROM source_maps WHERE release_id = ? AND minified_file = ? AND debug_id IS ?',
      )
      .get(releaseId, normalized, debugId) as { id: string; map_path: string } | undefined;
    previousPath = previous?.map_path;
    if (previous) {
      database.sqlite
        .prepare('UPDATE source_maps SET map_path = ?, created_at = ? WHERE id = ?')
        .run(mapPath, now, previous.id);
      row = { id: previous.id };
    } else {
      row = { id: randomUUID() };
      database.sqlite
        .prepare(
          `INSERT INTO source_maps (id, release_id, minified_file, debug_id, map_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(row.id, releaseId, normalized, debugId, mapPath, now);
    }
  } catch (error) {
    consumer.destroy();
    await rm(mapPath, { force: true });
    throw error;
  }
  // 校验时已经完整解析过，直接放进缓存，回填不必再解析一遍。
  consumers.replace(mapPath, consumer, content.length);
  if (previousPath && previousPath !== mapPath) {
    consumers.invalidate(previousPath);
    await rm(previousPath, { force: true });
  }
  // 回填：常见顺序是「先发版、线上报错、再补传 map」，上传后立即把用得上这份 map 的已有事件还原一遍，
  // 不必等新的错误发生才能看到源码栈。
  await symbolicateReleaseEvents(database, releaseId, { minifiedFile: normalized, debugId });
  return { id: row.id, releaseId, minifiedFile: normalized, debugId, createdAt: now };
}

export function listSourceMaps(database: TraceDatabase, releaseId: string): SourceMapRecord[] {
  const rows = database.sqlite
    .prepare(
      'SELECT id, release_id, minified_file, debug_id, created_at FROM source_maps WHERE release_id = ? ORDER BY created_at DESC',
    )
    .all(releaseId) as Array<{
    id: string;
    release_id: string;
    minified_file: string;
    debug_id: string | null;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    releaseId: row.release_id,
    minifiedFile: row.minified_file,
    debugId: row.debug_id,
    createdAt: row.created_at,
  }));
}

/** 为一个事件的栈帧找 map 的依据。 */
export interface MapLookup {
  projectId: string;
  /** 事件所属的版本；版本还没登记时为 null，只能按 Debug ID 找。 */
  releaseId: string | null;
  /** 事件带来的 Debug ID（MonitorEvent.debugIds）。 */
  debugIds?: MonitorEvent['debugIds'];
}

/** 由已入库的事件得出它的查找依据：Debug ID 存在 context_json 里。 */
export function lookupFor(projectId: string, event: StoredEvent): MapLookup {
  return {
    projectId,
    releaseId: event.releaseId ?? null,
    debugIds: event.context.debugIds,
  };
}

/** 去掉地址里的查询参数和片段：SDK 和服务端的脱敏都会删掉它们，两边按同样的形式比较。 */
function assetUrl(file: string): string {
  return file.replace(/[?#].*$/, '');
}

/** 找 map 的两条语句，每个数据库连接编译一次：回填 2,000 个事件时每个事件都编译一遍，光编译就要几十毫秒。 */
const findStatements = new WeakMap<
  BetterSqlite3.Database,
  { byDebugId: BetterSqlite3.Statement; byReleaseFile: BetterSqlite3.Statement }
>();

function statementsFor(sqlite: BetterSqlite3.Database) {
  let statements = findStatements.get(sqlite);
  if (!statements) {
    statements = {
      byDebugId: sqlite.prepare(
        `SELECT s.map_path FROM source_maps s JOIN releases r ON r.id = s.release_id
         WHERE s.debug_id = ? AND r.project_id = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
      ),
      // 同名文件有多份（重新构建过）时取最新上传的一份；同一毫秒内上传的按写入顺序（rowid）。
      byReleaseFile: sqlite.prepare(
        `SELECT map_path FROM source_maps WHERE release_id = ? AND minified_file = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ),
    };
    findStatements.set(sqlite, statements);
  }
  return statements;
}

/**
 * 返回一个按栈帧文件地址找 map 路径的函数。
 *
 * 1. 堆栈里的这个文件带了 Debug ID：在整个项目里找带这个 Debug ID 的 map，不看事件声明的版本。
 *    同一份内容在多个版本里上传过时取最新的一份（内容相同，哪份都对）。
 * 2. 没有 Debug ID，或者这个 Debug ID 没有上传过 map（例如 map 是手动上传、不带 Debug ID 的）：
 *    退回「事件的版本 + 文件名」。Sentry 也是这个顺序。
 */
function mapFinder(database: TraceDatabase, lookup: MapLookup): (file: string) => string | null {
  const { byDebugId, byReleaseFile } = statementsFor(database.sqlite);
  const debugIds = new Map(
    (lookup.debugIds ?? []).map((item) => [assetUrl(item.file), item.debugId]),
  );
  return (file) => {
    const debugId = debugIds.get(assetUrl(file));
    const viaDebugId = debugId
      ? (byDebugId.get(debugId, lookup.projectId) as { map_path: string } | undefined)
      : undefined;
    if (viaDebugId) return viaDebugId.map_path;
    if (!lookup.releaseId) return null;
    const viaRelease = byReleaseFile.get(lookup.releaseId, normalizeMinifiedFile(file)) as
      { map_path: string } | undefined;
    return viaRelease?.map_path ?? null;
  };
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

/**
 * 每份 map 里已经按行拆开的源码（sourcesContent），按 Consumer 缓存：同一个文件的出错行在接入、
 * 聚合和读源码时会被反复查询，每次都把整个文件 split 一遍太浪费。Consumer 被缓存淘汰、
 * 不再被引用之后，这里的条目随之被垃圾回收（WeakMap 不阻止回收）。
 */
const sourceLines = new WeakMap<SourceMapConsumer, Map<string, string[] | null>>();

function linesOf(consumer: SourceMapConsumer, rawSource: string): string[] | null {
  let byFile = sourceLines.get(consumer);
  if (!byFile) {
    byFile = new Map();
    sourceLines.set(consumer, byFile);
  }
  let lines = byFile.get(rawSource);
  if (lines === undefined) {
    const content = consumer.sourceContentFor(rawSource, true);
    lines = content ? content.split('\n') : null;
    byFile.set(rawSource, lines);
  }
  return lines;
}

function originalPosition(consumer: SourceMapConsumer, frame: StackFrame): OriginalPosition | null {
  // 第 0 行的帧（eval 出来的代码等会产生）source-map 会直接抛错。这不是 map 损坏，只是这一帧映射不到；
  // 让它抛出去，缓存会把整份 map 当成损坏，之后所有事件都不再还原。
  if (frame.lineNumber < 1) return null;
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

/** 一帧的还原结果：压缩位置，以及能映射时的源码位置。聚合和展示都从这里取。 */
export interface ResolvedFrame {
  /** 堆栈里的原始一行（去掉首尾空白）。 */
  raw: string;
  /** 压缩文件的地址。 */
  file: string;
  functionName?: string;
  original?: {
    source: string;
    line: number;
    /** 1 基，和浏览器一致。 */
    column: number;
    name: string | null;
    /** 出错那一行源码，去掉首尾空白；map 没有内联源码时为 null。 */
    contextLine: string | null;
  };
}

export interface ResolvedStack {
  /** 堆栈里每一个栈帧，按出现顺序；不是栈帧的行（错误消息、Caused by:）不在其中。 */
  frames: ResolvedFrame[];
  /** 还原后的完整堆栈；一帧都没映射到时为 null，调用方保留压缩堆栈。 */
  text: string | null;
}

/**
 * 逐帧把压缩堆栈翻译成源码位置。找不到 map 或映射不到的帧原样保留，
 * 所以结果可能一部分是源码位置、一部分仍是压缩位置。
 */
export async function resolveStack(
  database: TraceDatabase,
  lookup: MapLookup,
  stack: string,
): Promise<ResolvedStack> {
  const findMap = mapFinder(database, lookup);
  const frames: ResolvedFrame[] = [];
  const lines: string[] = [];
  let mapped = 0;
  for (const line of stack.split('\n')) {
    const frame = parseStackFrame(line);
    if (!frame) {
      lines.push(line);
      continue;
    }
    const mapPath = findMap(frame.file);
    // 同一份 map 在缓存里只解析一次；同一堆栈的多帧、同一批的多个事件都复用它。
    const original = mapPath
      ? await consumers.use(mapPath, (consumer) => {
          const position = originalPosition(consumer, frame);
          if (!position) return null;
          const code = linesOf(consumer, position.rawSource)?.[position.line - 1]?.trim();
          return { ...position, contextLine: code ? code.slice(0, 300) : null };
        })
      : null;
    frames.push({
      raw: line.trim(),
      file: frame.file,
      ...(frame.functionName ? { functionName: frame.functionName } : {}),
      ...(original
        ? {
            original: {
              source: original.source,
              line: original.line,
              column: original.column + 1,
              name: original.name,
              contextLine: original.contextLine,
            },
          }
        : {}),
    });
    if (original) {
      const fn = original.name ?? frame.functionName ?? '<anonymous>';
      lines.push(`    at ${fn} (${original.source}:${original.line}:${original.column + 1})`);
      mapped += 1;
    } else {
      lines.push(line);
    }
  }
  return { frames, text: mapped > 0 ? lines.join('\n') : null };
}

/** 只要还原后的堆栈文本（回填和测试用）；一帧都未命中时返回 null。 */
export async function symbolicateStack(
  database: TraceDatabase,
  lookup: MapLookup,
  stack: string,
): Promise<string | null> {
  return (await resolveStack(database, lookup, stack)).text;
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
  lookup: MapLookup,
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
  const mapPath = mapFinder(database, lookup)(frame.file);
  if (!mapPath) return { ok: false, reason: 'NO_SOURCE_MAP' };

  // 登记了但读不到（文件被清理或损坏），对调查来说就是缺少 map。
  const result = await consumers.use(mapPath, (consumer): SourceContextResult => {
    const original = originalPosition(consumer, frame);
    if (!original) return { ok: false, reason: 'FRAME_NOT_MAPPED' };
    const lines = linesOf(consumer, original.rawSource);
    if (!lines) return { ok: false, reason: 'NO_SOURCES_CONTENT' };
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

/** 上传 map 后要回填的一个事件。 */
export interface StoredStack {
  eventId: string;
  lookup: MapLookup;
  stack: string;
}

/**
 * 逐个还原并写回 events.original_stack，返回还原成功和失败的条数。上传 map 后回填已有事件时使用；
 * 新接入的事件在入库之前就还原了（services/events.ts）。
 *
 * 单个事件还原失败只计数、不抛出：还原是附加信息，它的失败不能让上传或接入返回 500。
 * 曾经这里一抛错，接入就返回 500，而事件其实已经提交；SDK 把 500 当作可重试，
 * 同一批反复重发、反复失败，这个浏览器之后的事件全部堵在它身后。
 */
export async function symbolicateEvents(
  database: TraceDatabase,
  items: StoredStack[],
): Promise<{ mapped: number; failed: number }> {
  const updates: Array<[string, string]> = [];
  let failed = 0;
  for (const item of items) {
    try {
      const originalStack = await symbolicateStack(database, item.lookup, item.stack);
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

interface BackfillRow {
  id: string;
  release_id: string;
  project_id: string;
  stack: string;
  /** context_json 里的 debugIds（JSON 文本），没有时为 NULL。 */
  debug_ids: string | null;
}

/**
 * 用当前已上传的 map 重新还原历史事件，返回成功还原的条数。
 *
 * 不指定 upload 时重算这个版本的全部事件。指定时只处理用得上这份 map 的事件：
 * - 这个版本里、堆栈出现过这个文件名的（按版本 + 文件名找 map 的事件）；
 * - map 带 Debug ID 时，整个项目里带着这个 Debug ID 的（版本号对不上也能找到它）。
 * 与它无关的事件不必重算（曾经上传任何 map 都会把整个版本的事件重新还原一遍）。
 */
export async function symbolicateReleaseEvents(
  database: TraceDatabase,
  releaseId: string,
  upload?: { minifiedFile: string; debugId: string | null },
): Promise<number> {
  // 只取出 context_json 里的 debugIds：整段上下文（payload、设备信息）在 JS 里逐个解析，2,000 个事件要多花几十毫秒。
  const columns =
    "e.id, e.release_id, r.project_id, e.stack, json_extract(e.context_json, '$.debugIds') AS debug_ids";
  const rows = new Map<string, BackfillRow>();
  const sameRelease = (
    upload
      ? database.sqlite
          .prepare(
            `SELECT ${columns} FROM events e JOIN releases r ON r.id = e.release_id
             WHERE e.release_id = ? AND e.stack IS NOT NULL AND instr(e.stack, ?) > 0`,
          )
          .all(releaseId, upload.minifiedFile)
      : database.sqlite
          .prepare(
            `SELECT ${columns} FROM events e JOIN releases r ON r.id = e.release_id
             WHERE e.release_id = ? AND e.stack IS NOT NULL`,
          )
          .all(releaseId)
  ) as BackfillRow[];
  for (const row of sameRelease) rows.set(row.id, row);
  if (upload?.debugId) {
    // 按项目的各个版本走 events_release 索引，再在 context_json 里找这个 Debug ID。
    // 没有为 Debug ID 单独建索引：回填只在上传时发生，代价随项目事件数线性增长，见 docs/server.md。
    const viaDebugId = database.sqlite
      .prepare(
        `SELECT ${columns} FROM events e JOIN releases r ON r.id = e.release_id
         WHERE r.project_id = (SELECT project_id FROM releases WHERE id = ?)
           AND e.stack IS NOT NULL AND instr(e.context_json, ?) > 0`,
      )
      .all(releaseId, upload.debugId) as BackfillRow[];
    for (const row of viaDebugId) rows.set(row.id, row);
  }
  const { mapped } = await symbolicateEvents(
    database,
    [...rows.values()].map((row) => ({
      eventId: row.id,
      lookup: {
        projectId: row.project_id,
        releaseId: row.release_id,
        debugIds: row.debug_ids
          ? parseJson<MonitorEvent['debugIds']>(row.debug_ids, undefined)
          : undefined,
      },
      stack: row.stack,
    })),
  );
  return mapped;
}
