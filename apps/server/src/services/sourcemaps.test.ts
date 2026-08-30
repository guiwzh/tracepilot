import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMapGenerator } from 'source-map';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import { saveSourceMap, symbolicateStack } from './sourcemaps';

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
  await rm(directory, { recursive: true, force: true });
});

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
    // 同一份 map 会被堆栈里的多个 frame 命中。Consumer 现在按 map 缓存并在结束时统一释放，
    // 因此这里既验证复用后的映射仍然正确，也覆盖未命中帧保留原文的降级分支。
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
});
