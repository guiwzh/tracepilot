import { SourceMapConsumer, SourceMapGenerator } from 'source-map';
import { describe, expect, it } from 'vitest';
import { DEBUG_ID_PATTERN, DEBUG_ID_REGISTRY } from '@trace-pilot/shared';
import { debugIdFor, injectDebugId, registrySnippet } from '../src/debugId';

/** 产物第 line 行第 0 列映射到 src/app.ts 第 original 行。 */
function mapOf(entries: Array<[line: number, original: number]>) {
  const generator = new SourceMapGenerator({ file: 'app.js' });
  for (const [line, original] of entries) {
    generator.addMapping({
      generated: { line, column: 0 },
      original: { line: original, column: 0 },
      source: 'src/app.ts',
    });
  }
  return JSON.parse(generator.toString()) as { mappings: string };
}

async function originalLine(map: unknown, line: number): Promise<number | null> {
  const consumer = await new SourceMapConsumer(map as never);
  try {
    return consumer.originalPositionFor({ line, column: 0 }).line;
  } finally {
    consumer.destroy();
  }
}

describe('debug IDs', () => {
  it('derives the same UUID from the same content and a new one when it changes', () => {
    const id = debugIdFor('console.log(1)');
    expect(id).toMatch(DEBUG_ID_PATTERN);
    expect(id[14]).toBe('4');
    expect(debugIdFor('console.log(1)')).toBe(id);
    expect(debugIdFor('console.log(2)')).not.toBe(id);
  });

  it('registers the ID under the stack of the file it runs in', () => {
    const snippet = registrySnippet('11111111-2222-4333-8444-555555555555');
    const global = globalThis as Record<string, unknown>;
    try {
      new Function(snippet)();
      const registry = global[DEBUG_ID_REGISTRY] as Record<string, string>;
      expect(Object.values(registry)).toEqual(['11111111-2222-4333-8444-555555555555']);
      expect(Object.keys(registry)[0]).toMatch(/^Error/);
    } finally {
      delete global[DEBUG_ID_REGISTRY];
    }
  });

  it('shifts the mappings by exactly the line it inserts', async () => {
    const code = 'const total = 1;\nthrow new Error(total);';
    const map = mapOf([
      [1, 10],
      [2, 11],
    ]);
    const id = debugIdFor(code);
    const injected = injectDebugId(code, map, id);
    const lines = injected.code.split('\n');
    expect(lines[0]).toBe(registrySnippet(id));
    expect(lines[2]).toBe('throw new Error(total);');
    expect(lines.at(-2)).toBe(`//# debugId=${id}`);
    expect(injected.map.debugId).toBe(id);
    // 原来第 2 行的代码现在在第 3 行，map 也要把第 3 行映射回源码第 11 行。
    expect(await originalLine(injected.map, 3)).toBe(11);
    expect(await originalLine(injected.map, 2)).toBe(10);
    expect(await originalLine(injected.map, 1)).toBeNull();
  });

  it("keeps a hashbang and a 'use strict' line first", async () => {
    const code = "#!/usr/bin/env node\n'use strict';\nrun();";
    const injected = injectDebugId(code, mapOf([[3, 7]]), debugIdFor(code));
    const lines = injected.code.split('\n');
    expect(lines.slice(0, 2)).toEqual(['#!/usr/bin/env node', "'use strict';"]);
    expect(lines[2]).toContain(DEBUG_ID_REGISTRY);
    expect(lines[3]).toBe('run();');
    expect(await originalLine(injected.map, 4)).toBe(7);
  });
});
