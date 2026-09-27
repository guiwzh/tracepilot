/**
 * 已解析 Source Map 的进程级缓存（LRU：最久没用的先淘汰）。
 *
 * 解析一份 map 的 mappings 是还原链路里最贵的一步（8 MB 的 map 约 55 ms，同步执行、阻塞事件循环），
 * 而同一个 Release 的每个错误都要用到同一份 map。早期实现每还原一个事件就解析一遍：
 * 带 map 的 10 个错误一批接入要 0.7 s，上传 map 时回填 200 个事件要 14 s。
 * 缓存之后，接入、回填和排障 Agent 查看源码共用同一份解析结果。
 *
 * 难点在释放。source-map 的 Consumer 把数据放在 WebAssembly 内存里，垃圾回收管不到，
 * 淘汰时必须手动 destroy()。可淘汰随时可能发生：一个请求在 await 加载时，另一个请求插入新条目，
 * 把它正要用的那份挤了出去。所以每次使用都是一次「借出」：借出期间被淘汰的条目先从缓存里摘掉，
 * 等最后一个借用者用完再销毁。借出的回调必须是同步的，保证用的时候对象一定还活着。
 */

/** 任何需要手动释放的已解析对象；生产环境里是 SourceMapConsumer。 */
export interface Releasable {
  destroy(): void;
}

/** 加载一份 map：解析好的对象和它的原始大小（用于内存预算）；读不到或解析失败时为 null。 */
export type CacheLoader<T extends Releasable> = (
  path: string,
) => Promise<{ value: T; bytes: number } | null>;

interface Entry<T> {
  value: Promise<T | null>;
  bytes: number;
  leases: number;
  evicted: boolean;
  /** 解析成功、但查询时才暴露出损坏（mappings 是懒解析的）：整份 map 视为不可用。 */
  broken: boolean;
  destroyed: boolean;
}

export interface CacheLimits {
  /** 常驻缓存的 map 原始字节数上限。解析后的内存约为原始大小的 4～5 倍。 */
  budgetBytes: number;
  /** 条目数上限，包括读不到的 map（它们也会被记住，避免每一帧都重读磁盘）。 */
  maxEntries: number;
}

export class SourceMapCache<T extends Releasable> {
  /** Map 按插入顺序迭代：最前面的是最久没用的，每次命中都把条目移到末尾。 */
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;

  constructor(
    private readonly load: CacheLoader<T>,
    private readonly limits: CacheLimits,
  ) {}

  /**
   * 借出 path 对应的解析结果执行 read，返回它的结果。map 不可用时返回 null；
   * read 抛错（懒解析时才发现 map 损坏）也返回 null，并记住这份 map 不可用，不再逐帧重试。
   */
  async use<R>(path: string, read: (value: T) => R): Promise<R | null> {
    const entry = this.acquire(path);
    entry.leases += 1;
    try {
      const value = await entry.value;
      if (!value || entry.broken) return null;
      try {
        return read(value);
      } catch {
        entry.broken = true;
        return null;
      }
    } finally {
      entry.leases -= 1;
      if (entry.evicted && entry.leases === 0) this.destroy(entry);
    }
  }

  /** 放入一份刚上传、已经完整校验过的解析结果，替换同一路径的旧条目；回填就不必再解析一遍。 */
  replace(path: string, value: T, bytes: number): void {
    this.invalidate(path);
    this.entries.set(path, this.entry(Promise.resolve(value), bytes));
    this.bytes += bytes;
    this.trim(path);
  }

  /** 丢弃 path 的条目（文件被覆盖或删除时调用）。正在被借用的，等借用结束再销毁。 */
  invalidate(path: string): void {
    const entry = this.entries.get(path);
    if (entry) this.evict(path, entry);
  }

  /** 丢弃全部条目；应用关闭时调用。 */
  clear(): void {
    for (const [path, entry] of [...this.entries]) this.evict(path, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  private acquire(path: string): Entry<T> {
    const cached = this.entries.get(path);
    if (cached) {
      this.entries.delete(path);
      this.entries.set(path, cached);
      return cached;
    }
    const entry = this.entry(Promise.resolve(null), 0);
    entry.value = this.load(path).then(
      (loaded) => {
        if (!loaded) return null;
        // 加载期间已被淘汰的条目不再计入预算；它的对象由最后一个借用者销毁。
        if (!entry.evicted) {
          entry.bytes = loaded.bytes;
          this.bytes += loaded.bytes;
          this.trim(path);
        }
        return loaded.value;
      },
      // 加载器按约定不抛错；万一抛了，也只当作这份 map 不可用。
      () => null,
    );
    this.entries.set(path, entry);
    this.trim(path);
    return entry;
  }

  private entry(value: Promise<T | null>, bytes: number): Entry<T> {
    return { value, bytes, leases: 0, evicted: false, broken: false, destroyed: false };
  }

  /** 超出预算时从最久没用的开始淘汰；keep 是刚放入的条目，单份超过预算也保留它。 */
  private trim(keep: string): void {
    for (const [path, entry] of this.entries) {
      if (this.bytes <= this.limits.budgetBytes && this.entries.size <= this.limits.maxEntries) {
        return;
      }
      if (path !== keep) this.evict(path, entry);
    }
  }

  private evict(path: string, entry: Entry<T>): void {
    this.entries.delete(path);
    if (!entry.evicted) this.bytes -= entry.bytes;
    entry.evicted = true;
    if (entry.leases === 0) this.destroy(entry);
  }

  private destroy(entry: Entry<T>): void {
    if (entry.destroyed) return;
    entry.destroyed = true;
    void entry.value.then((value) => value?.destroy());
  }
}
