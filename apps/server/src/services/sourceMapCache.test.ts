import { describe, expect, it } from 'vitest';
import { SourceMapCache, type CacheLoader } from './sourceMapCache';

class FakeConsumer {
  destroyed = false;
  constructor(readonly name: string) {}
  destroy() {
    this.destroyed = true;
  }
  read() {
    if (this.destroyed) throw new Error(`${this.name} used after destroy`);
    return this.name;
  }
}

/** 可以手动决定何时完成的加载器，用来构造「加载途中被淘汰」这类时序。 */
function controllableLoader(bytes = 10) {
  const loads: string[] = [];
  const pending = new Map<string, (value: FakeConsumer) => void>();
  const load: CacheLoader<FakeConsumer> = (path) => {
    loads.push(path);
    return new Promise((resolve) => {
      pending.set(path, (value) => resolve({ value, bytes }));
    });
  };
  const finish = (path: string) => {
    const consumer = new FakeConsumer(path);
    pending.get(path)!(consumer);
    return consumer;
  };
  return { load, loads, finish };
}

function eagerLoader(bytes = 10) {
  const loads: string[] = [];
  const created: FakeConsumer[] = [];
  const load: CacheLoader<FakeConsumer> = async (path) => {
    loads.push(path);
    const consumer = new FakeConsumer(path);
    created.push(consumer);
    return { value: consumer, bytes };
  };
  return { load, loads, created };
}

describe('source map cache', () => {
  it('loads a map once no matter how many readers ask for it', async () => {
    const { load, loads } = eagerLoader();
    const cache = new SourceMapCache(load, { budgetBytes: 100, maxEntries: 4 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.use('a.map', (consumer) => consumer.read())),
    );
    expect(results).toEqual(Array(10).fill('a.map'));
    expect(loads).toEqual(['a.map']);
  });

  it('evicts the least recently used map and releases its memory', async () => {
    const { load, created } = eagerLoader(40);
    const cache = new SourceMapCache(load, { budgetBytes: 100, maxEntries: 10 });
    await cache.use('a.map', (consumer) => consumer.read());
    await cache.use('b.map', (consumer) => consumer.read());
    await cache.use('a.map', (consumer) => consumer.read());
    // 第三份超出 100 字节预算：最久没用的是 b，不是最早加载的 a。
    await cache.use('c.map', (consumer) => consumer.read());
    await Promise.resolve();
    expect(created.map((consumer) => [consumer.name, consumer.destroyed])).toEqual([
      ['a.map', false],
      ['b.map', true],
      ['c.map', false],
    ]);
  });

  it('does not destroy a map another request is about to read', async () => {
    const { load, finish } = controllableLoader();
    const cache = new SourceMapCache(load, { budgetBytes: 1_000, maxEntries: 1 });
    // 请求 1 在等 a 加载；请求 2 插入 b，按条目上限把 a 挤出了缓存。
    const first = cache.use('a.map', (consumer) => consumer.read());
    const second = cache.use('b.map', (consumer) => consumer.read());
    const a = finish('a.map');
    finish('b.map');
    // 被淘汰的 a 仍要交给请求 1 用完，而不是在它读之前被销毁。
    await expect(first).resolves.toBe('a.map');
    await expect(second).resolves.toBe('b.map');
    await Promise.resolve();
    expect(a.destroyed).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('serves the new content after a map is replaced', async () => {
    const { load, created } = eagerLoader();
    const cache = new SourceMapCache(load, { budgetBytes: 100, maxEntries: 4 });
    await cache.use('app.map', (consumer) => consumer.read());
    const uploaded = new FakeConsumer('app.map (re-uploaded)');
    cache.replace('app.map', uploaded, 10);
    await expect(cache.use('app.map', (consumer) => consumer.read())).resolves.toBe(
      'app.map (re-uploaded)',
    );
    await Promise.resolve();
    expect(created[0]!.destroyed).toBe(true);
  });

  it('remembers a map that fails when queried instead of retrying it for every frame', async () => {
    let queries = 0;
    const cache = new SourceMapCache<FakeConsumer>(
      async (path) => ({ value: new FakeConsumer(path), bytes: 1 }),
      { budgetBytes: 100, maxEntries: 4 },
    );
    const failing = () => {
      queries += 1;
      throw new Error('Error parsing mappings');
    };
    expect(await cache.use('broken.map', failing)).toBeNull();
    expect(await cache.use('broken.map', failing)).toBeNull();
    expect(queries).toBe(1);
  });

  it('treats an unreadable map as missing', async () => {
    const cache = new SourceMapCache<FakeConsumer>(async () => null, {
      budgetBytes: 100,
      maxEntries: 4,
    });
    expect(await cache.use('gone.map', (consumer) => consumer.read())).toBeNull();
  });
});
