import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SourceMapGenerator } from 'source-map';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import {
  clearSourceMapCache,
  InvalidSourceMapError,
  resolveStack,
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
function storeEvent(id: string, stack: string, releaseId = 'demo-release-2-4-1', context = {}) {
  database.sqlite
    .prepare(
      `INSERT INTO events (id, release_id, type, message, stack, page_url, context_json, breadcrumbs_json, created_at)
       VALUES (?, ?, 'error', 'failure', ?, '/', ?, '[]', ?)`,
    )
    .run(id, releaseId, stack, JSON.stringify(context), Date.now());
}

function originalStackOf(id: string): string | null {
  return (
    database.sqlite.prepare('SELECT original_stack FROM events WHERE id = ?').get(id) as {
      original_stack: string | null;
    }
  ).original_stack;
}

const APP_STACK = 'TypeError: failure\n    at submit (https://shop.test/assets/app.js:1:10)';
/** 演示项目 2.4.1 版本的事件、不带 Debug ID：按「版本 + 文件名」找 map。 */
const DEMO = { projectId: 'demo-project', releaseId: 'demo-release-2-4-1' };

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
      DEMO,
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
      DEMO,
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
        DEMO,
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
      Array.from({ length: 20 }, () => symbolicateStack(database, DEMO, APP_STACK)),
    );
    expect(results.every((stack) => stack?.includes('src/cart.ts:12:5'))).toBe(true);
    // 曾经每个事件都要读一次文件、解析一次 mappings：8 MB 的 map 一次约 55 ms。
    expect(mapReads()).toBe(1);
  });

  it('serves the new mappings as soon as a map is uploaded again', async () => {
    const mapPath = () =>
      (database.sqlite.prepare('SELECT map_path FROM source_maps').get() as { map_path: string })
        .map_path;
    await upload('app.js', appMap('src/cart.ts', 12));
    const first = mapPath();
    expect(await symbolicateStack(database, DEMO, APP_STACK)).toContain('src/cart.ts:12:5');
    await upload('app.js', appMap('src/total.ts', 40));
    expect(await symbolicateStack(database, DEMO, APP_STACK)).toContain('src/total.ts:40:5');
    // 每次上传写新文件、删掉旧文件：按路径缓存的解析结果永远对应同一份内容，
    // 别的进程（pnpm seed）替换 map 之后，服务进程的缓存也不会过期而不自知。
    expect(mapPath()).not.toBe(first);
    expect(await readdir(join(directory, 'maps'))).toEqual([basename(mapPath())]);
  });

  it('skips a frame on line 0 without giving up on the map', async () => {
    // 回归：source-map 对第 0 行直接抛错，缓存曾因此把整份 map 当成损坏，之后所有事件都不再还原。
    await upload('app.js', appMap('src/cart.ts', 12));
    const stack = [
      'Error: from eval',
      '    at eval (https://shop.test/assets/app.js:0:1)',
      '    at submit (https://shop.test/assets/app.js:1:10)',
    ].join('\n');
    const mapped = await symbolicateStack(database, DEMO, stack);
    expect(mapped).toContain('at eval (https://shop.test/assets/app.js:0:1)');
    expect(mapped).toContain('src/cart.ts:12:5');
    expect(await symbolicateStack(database, DEMO, APP_STACK)).toContain('src/cart.ts:12:5');
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

    expect(await symbolicateStack(database, DEMO, APP_STACK)).toBeNull();
    expect(await sourceContext(database, DEMO, APP_STACK)).toEqual({
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

describe('finding maps by debug ID', () => {
  const OLD_BUILD = '0a1b2c3d-0000-4000-8000-000000000001';
  const NEW_BUILD = '0a1b2c3d-0000-4000-8000-000000000002';
  const APP_URL = 'https://shop.test/assets/app.js';

  /** 构建插件产出的 map：和 appMap 一样，多一个 debugId 字段。 */
  function mapWithDebugId(source: string, line: number, debugId: string): Buffer {
    return Buffer.from(JSON.stringify({ ...JSON.parse(appMap(source, line).toString()), debugId }));
  }

  function addRelease(id: string, projectId = 'demo-project') {
    database.sqlite
      .prepare('INSERT INTO releases (id, project_id, version, created_at) VALUES (?, ?, ?, 0)')
      .run(id, projectId, id);
  }

  it('records the debug ID written into the map', async () => {
    await expect(
      upload('app.js', mapWithDebugId('src/cart.ts', 12, OLD_BUILD)),
    ).resolves.toMatchObject({ minifiedFile: 'app.js', debugId: OLD_BUILD });
    // 早期工具写的是 debug_id；大写的 UUID 统一成小写。
    const legacyField = {
      ...JSON.parse(appMap('src/v.ts', 1).toString()),
      debug_id: NEW_BUILD.toUpperCase(),
    };
    await expect(
      upload('vendor.js', Buffer.from(JSON.stringify(legacyField))),
    ).resolves.toMatchObject({
      debugId: NEW_BUILD,
    });
  });

  it('rejects a debug ID that is not a UUID instead of ignoring it', async () => {
    await expect(
      upload('app.js', mapWithDebugId('src/cart.ts', 12, 'build-42')),
    ).rejects.toBeInstanceOf(InvalidSourceMapError);
  });

  it('finds the map when the event reports a release the map was not uploaded to', async () => {
    // 版本号对不上：SDK 配置的是 2.4.2，map 上传到了 2.4.1。
    addRelease('demo-release-2-4-2');
    await upload('app.js', mapWithDebugId('src/cart.ts', 12, OLD_BUILD));
    const lookup = { projectId: 'demo-project', releaseId: 'demo-release-2-4-2' };
    expect(await symbolicateStack(database, lookup, APP_STACK)).toBeNull();
    expect(
      await symbolicateStack(
        database,
        // 地址里的查询参数被脱敏删掉了，两边按去掉查询参数的地址比较。
        { ...lookup, debugIds: [{ file: `${APP_URL}?v=3`, debugId: OLD_BUILD }] },
        APP_STACK,
      ),
    ).toContain('src/cart.ts:12:5');
    // 版本还没登记也一样。
    expect(
      await symbolicateStack(
        database,
        {
          projectId: 'demo-project',
          releaseId: null,
          debugIds: [{ file: APP_URL, debugId: OLD_BUILD }],
        },
        APP_STACK,
      ),
    ).toContain('src/cart.ts:12:5');
  });

  it('keeps the map of an earlier build that reused the same file name', async () => {
    // 同一个版本号重新构建、文件名不带内容哈希：两份 map 并存，旧页面的事件仍按旧 map 还原。
    await upload('app.js', mapWithDebugId('src/old.ts', 12, OLD_BUILD));
    await upload('app.js', mapWithDebugId('src/new.ts', 40, NEW_BUILD));
    const withId = (debugId: string) => ({ ...DEMO, debugIds: [{ file: APP_URL, debugId }] });
    expect(await symbolicateStack(database, withId(OLD_BUILD), APP_STACK)).toContain(
      'src/old.ts:12:5',
    );
    expect(await symbolicateStack(database, withId(NEW_BUILD), APP_STACK)).toContain(
      'src/new.ts:40:5',
    );
    // 不带 Debug ID 的事件（旧版 SDK）按版本 + 文件名，取最新上传的一份。
    expect(await symbolicateStack(database, DEMO, APP_STACK)).toContain('src/new.ts:40:5');
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM source_maps').get()).toEqual({
      count: 2,
    });
    // 同一份内容再传一次是替换，不是新增。
    await upload('app.js', mapWithDebugId('src/new.ts', 41, NEW_BUILD));
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM source_maps').get()).toEqual({
      count: 2,
    });
  });

  it('falls back to release and file name when no map carries the debug ID', async () => {
    // map 是手动上传的，没有 Debug ID；产物里却注入了。
    await upload('app.js', appMap('src/cart.ts', 12));
    const resolved = await resolveStack(
      database,
      { ...DEMO, debugIds: [{ file: APP_URL, debugId: NEW_BUILD }] },
      APP_STACK,
    );
    expect(resolved.frames[0]?.original).toMatchObject({ source: 'src/cart.ts', line: 12 });
  });

  it('never uses a map that belongs to another project', async () => {
    // Debug ID 不是秘密（就写在公开的产物文件里），按它查找必须限定在事件所属的项目里，
    // 否则别的项目能借一个 Debug ID 读到这个项目的源码。
    database.sqlite
      .prepare(
        "INSERT INTO projects (id, name, dsn_key, created_at) VALUES ('other', 'Other', 'other-key', 0)",
      )
      .run();
    addRelease('other-release', 'other');
    await saveSourceMap(
      database,
      join(directory, 'maps'),
      'other-release',
      'app.js',
      mapWithDebugId('src/secret.ts', 3, OLD_BUILD),
    );
    const lookup = {
      projectId: 'demo-project',
      releaseId: null,
      debugIds: [{ file: APP_URL, debugId: OLD_BUILD }],
    };
    expect(await symbolicateStack(database, lookup, APP_STACK)).toBeNull();
    expect(await sourceContext(database, lookup, APP_STACK)).toEqual({
      ok: false,
      reason: 'NO_SOURCE_MAP',
    });
  });

  it('backfills events of any release that carry the uploaded debug ID', async () => {
    addRelease('demo-release-2-4-2');
    storeEvent('mislabelled', APP_STACK, 'demo-release-2-4-2', {
      debugIds: [{ file: APP_URL, debugId: OLD_BUILD }],
    });
    storeEvent('other-build', APP_STACK, 'demo-release-2-4-2', {
      debugIds: [{ file: APP_URL, debugId: NEW_BUILD }],
    });
    await upload('app.js', mapWithDebugId('src/cart.ts', 12, OLD_BUILD));
    expect(originalStackOf('mislabelled')).toContain('src/cart.ts:12:5');
    // 另一次构建的事件不是这份 map 的，不能被它还原。
    expect(originalStackOf('other-build')).toBeNull();
  });
});
