import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMapGenerator } from 'source-map';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import {
  clearSourceMapCache,
  InvalidSourceMapError,
  saveSourceMap,
  sourceContext,
  symbolicateReleaseEvents,
  symbolicateStack,
} from './sourcemaps';

// 包一层可计数的 readFile（行为不变），用来断言一份 map 只从磁盘读取、解析了几次。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// 用最小合法 Source Map 验证上传、行列映射和历史事件回填。
let directory: string;
let database: TraceDatabase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tracepilot-map-'));
  database = createDatabase(join(directory, 'test.db'));
  ensureDemoProject(database);
});

afterEach(async () => {
  database.close();
  clearSourceMapCache();
  vi.mocked(readFile).mockClear();
  await rm(directory, { recursive: true, force: true });
});

/** 从磁盘读取 map 文件的次数。 */
function mapReads(): number {
  return vi.mocked(readFile).mock.calls.filter(([path]) => String(path).endsWith('.map')).length;
}

/** 一个把 app.js 第 1 行第 10 列映射到 source 第 line 行的 map。 */
function appMap(source: string, line: number, name?: string): Buffer {
  const generator = new SourceMapGenerator({ file: 'app.js' });
  generator.addMapping({
    generated: { line: 1, column: 9 },
    original: { line, column: 4 },
    source,
    name,
  });
  return Buffer.from(generator.toString());
}

function upload(file: string, content: Buffer) {
  return saveSourceMap(database, join(directory, 'maps'), 'demo-release-2-4-1', file, content);
}

/** 直接写入一条带堆栈的事件，模拟「先报错、后上传 map」。 */
function storeEvent(id: string, stack: string) {
  database.sqlite
    .prepare(
      `INSERT INTO events (id, release_id, type, message, stack, page_url, context_json, breadcrumbs_json, created_at)
       VALUES (?, 'demo-release-2-4-1', 'error', 'failure', ?, '/', '{}', '[]', ?)`,
    )
    .run(id, stack, Date.now());
}

function originalStackOf(id: string): string | null {
  return (
    database.sqlite.prepare('SELECT original_stack FROM events WHERE id = ?').get(id) as {
      original_stack: string | null;
    }
  ).original_stack;
}

const APP_STACK = 'TypeError: failure\n    at submit (https://shop.test/assets/app.js:1:10)';

describe('source map symbolication', () => {
  it('maps a minified frame inside its release boundary', async () => {
    const generator = new SourceMapGenerator({ file: 'app.js' });
    generator.addMapping({
      generated: { line: 1, column: 9 },
      original: { line: 12, column: 4 },
      source: 'src/cart.ts',
      name: 'calculateTotal',
    });
    await saveSourceMap(
      database,
      join(directory, 'maps'),
      'demo-release-2-4-1',
      'app.js',
      Buffer.from(generator.toString()),
    );
    const mapped = await symbolicateStack(
      database,
      'demo-release-2-4-1',
      'TypeError: failure\n    at a (https://shop.test/assets/app.js:1:10)',
    );
    expect(mapped).toContain('at calculateTotal (src/cart.ts:12:5)');
  });

  it('maps every frame of a multi-frame stack from one shared consumer', async () => {
    // 同一份 map 会被堆栈里的多个 frame 命中，它们共用缓存里的同一个 Consumer。
    // 这里既验证复用后的映射仍然正确，也覆盖未命中帧保留原文的降级分支。
    const generator = new SourceMapGenerator({ file: 'app.js' });
    generator.addMapping({
      generated: { line: 1, column: 9 },
      original: { line: 12, column: 4 },
      source: 'src/cart.ts',
      name: 'calculateTotal',
    });
    generator.addMapping({
      generated: { line: 1, column: 40 },
      original: { line: 30, column: 8 },
      source: 'src/checkout.ts',
      name: 'submitOrder',
    });
    await saveSourceMap(
      database,
      join(directory, 'maps'),
      'demo-release-2-4-1',
      'app.js',
      Buffer.from(generator.toString()),
    );

    const mapped = await symbolicateStack(
      database,
      'demo-release-2-4-1',
      [
        'TypeError: failure',
        '    at a (https://shop.test/assets/app.js:1:10)',
        '    at b (https://shop.test/assets/app.js:1:41)',
        '    at c (https://shop.test/assets/vendor.js:1:5)',
      ].join('\n'),
    );

    expect(mapped).toContain('at calculateTotal (src/cart.ts:12:5)');
    expect(mapped).toContain('at submitOrder (src/checkout.ts:30:9)');
    // vendor.js 没有对应的 map，该帧原样保留。
    expect(mapped).toContain('at c (https://shop.test/assets/vendor.js:1:5)');
  });

  it('returns a clear null fallback when a release has no matching map', async () => {
    expect(
      await symbolicateStack(
        database,
        'demo-release-2-4-1',
        'Error: missing\n    at a (https://shop.test/assets/other.js:1:1)',
      ),
    ).toBeNull();
  });

  it('rejects a map it cannot parse before storing or registering it', async () => {
    // 回归：字段齐全却无法解析的 map 曾先落盘、登记，之后该版本每次还原都抛错。
    const broken = JSON.stringify({ version: 3, mappings: 'AAAA', sources: 'not-an-array' });
    await expect(
      saveSourceMap(
        database,
        join(directory, 'maps'),
        'demo-release-2-4-1',
        'app.js',
        Buffer.from(broken),
      ),
    ).rejects.toBeInstanceOf(InvalidSourceMapError);
    const registered = database.sqlite
      .prepare('SELECT COUNT(*) AS count FROM source_maps')
      .get() as {
      count: number;
    };
    expect(registered.count).toBe(0);
  });

  it('rejects maps whose mappings only fail when they are decoded', async () => {
    // 回归：source-map 在第一次查询时才解码 mappings。这两份 map 曾以 201 通过上传，
    // 之后该版本每一次带堆栈的接入都返回 500。
    const corrupt = { version: 3, file: 'app.js', sources: ['src/a.ts'], names: [] };
    for (const mappings of ['AAAA;!!!!', 'AAAA,CCCC']) {
      await expect(
        upload('app.js', Buffer.from(JSON.stringify({ ...corrupt, mappings }))),
      ).rejects.toBeInstanceOf(InvalidSourceMapError);
    }
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM source_maps').get()).toEqual({
      count: 0,
    });
    await expect(readdir(join(directory, 'maps'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('parses a map once for every event of a release', async () => {
    await upload('app.js', appMap('src/cart.ts', 12));
    clearSourceMapCache();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => symbolicateStack(database, 'demo-release-2-4-1', APP_STACK)),
    );
    expect(results.every((stack) => stack?.includes('src/cart.ts:12:5'))).toBe(true);
    // 曾经每个事件都要读一次文件、解析一次 mappings：8 MB 的 map 一次约 55 ms。
    expect(mapReads()).toBe(1);
  });

  it('serves the new mappings as soon as a map is uploaded again', async () => {
    await upload('app.js', appMap('src/cart.ts', 12));
    expect(await symbolicateStack(database, 'demo-release-2-4-1', APP_STACK)).toContain(
      'src/cart.ts:12:5',
    );
    await upload('app.js', appMap('src/total.ts', 40));
    expect(await symbolicateStack(database, 'demo-release-2-4-1', APP_STACK)).toContain(
      'src/total.ts:40:5',
    );
  });

  it('backfills only the events whose stack references the uploaded file', async () => {
    storeEvent('app-event', APP_STACK);
    storeEvent('vendor-event', 'Error: x\n    at v (https://shop.test/assets/vendor.js:1:1)');
    await upload('app.js', appMap('src/cart.ts', 12));
    expect(originalStackOf('app-event')).toContain('src/cart.ts:12:5');
    expect(originalStackOf('vendor-event')).toBeNull();

    // 上传另一个文件的 map：与它无关的 app-event 不再被重算，也就不必再读 app.js 的 map。
    clearSourceMapCache();
    const vendor = new SourceMapGenerator({ file: 'vendor.js' });
    vendor.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 7, column: 0 },
      source: 'src/vendor.ts',
    });
    await upload('vendor.js', Buffer.from(vendor.toString()));
    expect(originalStackOf('vendor-event')).toContain('src/vendor.ts:7:1');
    expect(mapReads()).toBe(0);
    expect(await symbolicateReleaseEvents(database, 'demo-release-2-4-1')).toBe(2);
  });

  it('treats a registered map whose file disappeared as a missing map', async () => {
    // 回归：map 文件被清理而登记还在时，每一次还原都抛错——接入返回 500，
    // 同一版本再上传别的 map 也因回填失败而被报成「不是合法的 map」。
    await upload('app.js', appMap('src/cart.ts', 12));
    const { map_path: mapPath } = database.sqlite
      .prepare('SELECT map_path FROM source_maps')
      .get() as { map_path: string };
    await unlink(mapPath);
    // 解析结果只在内存里；清空缓存相当于服务重启之后。
    clearSourceMapCache();

    expect(await symbolicateStack(database, 'demo-release-2-4-1', APP_STACK)).toBeNull();
    expect(await sourceContext(database, 'demo-release-2-4-1', APP_STACK)).toEqual({
      ok: false,
      reason: 'NO_SOURCE_MAP',
    });
    // 另一份 map 照常上传。
    const vendor = new SourceMapGenerator({ file: 'vendor.js' });
    vendor.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: 'v.ts',
    });
    await expect(upload('vendor.js', Buffer.from(vendor.toString()))).resolves.toMatchObject({
      minifiedFile: 'vendor.js',
    });
  });
});
