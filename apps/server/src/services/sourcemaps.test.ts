import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMapGenerator } from 'source-map';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, ensureDemoProject, type TraceDatabase } from '../db/client';
import { saveSourceMap, symbolicateStack } from './sourcemaps';

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
