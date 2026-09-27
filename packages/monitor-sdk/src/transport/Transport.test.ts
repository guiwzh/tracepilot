import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { Transport, utf8Length, type TransportInit } from './Transport';

// 注入假的 fetch / sendBeacon / storage，让每条发送路径完全可控，不依赖真实网络。
const event: MonitorEvent = {
  eventId: 'event-1',
  eventType: 'error',
  timestamp: 1,
  projectId: 'project',
  release: '1.0.0',
  environment: 'test',
  page: { url: 'https://test.local' },
  device: { userAgent: 'test' },
  payload: { message: 'failure' },
  breadcrumbs: [],
};

/** 与真实业务页面相当的错误事件：50 条网络 breadcrumb，序列化后约 16 KB。 */
function heavyEvent(eventId: string, breadcrumbCount = 50): MonitorEvent {
  return {
    ...event,
    eventId,
    breadcrumbs: Array.from({ length: breadcrumbCount }, (_, index) => ({
      id: `${eventId}-crumb-${index}`,
      type: 'network' as const,
      category: 'http',
      timestamp: index,
      message: `GET https://shop.example.com/api/v2/cart/items?sku=${index} → 200`,
      data: {
        method: 'GET',
        url: `https://shop.example.com/api/v2/cart/items?sku=${index}&ref=promo-campaign`,
        status: 200,
        duration: 123.45,
        success: true,
      },
    })),
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

/** 某个接入键下每个标签页留下的持久化副本：键 → 其中事件的 eventId。 */
function persistedCopies(storage: ReturnType<typeof memoryStorage>, dsnKey = 'public-key') {
  return [...storage.map.entries()]
    .filter(([key]) => key.startsWith(`tracepilot:pending:${dsnKey}`))
    .map(([key, value]) => ({
      key,
      eventIds: (JSON.parse(value) as MonitorEvent[]).map((item) => item.eventId),
    }));
}

function createTransport(overrides: Partial<TransportInit> = {}) {
  return new Transport({
    endpoint: 'https://ingest.test/envelopes',
    dsnKey: 'public-key',
    batchSize: 10,
    flushInterval: 60_000,
    maxRetries: 0,
    storage: null,
    ...overrides,
  });
}

function sentEvents(body: unknown): MonitorEvent[] {
  return (JSON.parse(String(body)) as { events: MonitorEvent[] }).events;
}

async function beaconEvents(sendBeacon: ReturnType<typeof vi.fn>, call = 0) {
  return sentEvents(await (sendBeacon.mock.calls[call]![1] as Blob).text());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Transport', () => {
  it('retries a failed batch and preserves the envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const transport = createTransport({ maxRetries: 1, fetchImpl });
    transport.enqueue(event);
    await transport.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).toMatchObject({
      dsnKey: 'public-key',
      events: [{ eventId: 'event-1' }],
    });
    expect(transport.pending()).toBe(0);
  });

  it('sends normal batches without keepalive so the 64 KiB quota cannot reject them', async () => {
    // 回归：早期实现给每个请求都加了 keepalive。10 个真实大小的错误事件约 165 KB，
    // 浏览器直接以 TypeError 拒绝，失败批次被放回队首，整个队列从此卡死。
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createTransport({ fetchImpl });
    for (let index = 0; index < 10; index += 1) transport.enqueue(heavyEvent(`heavy-${index}`));
    await transport.flush();

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.keepalive).toBeFalsy();
    expect(utf8Length(init.body as string)).toBeGreaterThan(65_536);
    // text/plain 是 CORS 安全列表类型，跨域上报不需要预检。
    expect(init.headers).toEqual({ 'content-type': 'text/plain;charset=UTF-8' });
    expect(transport.pending()).toBe(0);
  });

  it('does not let a batch the server rejects block the rest of the queue', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createTransport({ batchSize: 1, maxRetries: 2, fetchImpl });
    transport.enqueue({ ...event, eventId: 'rejected' });
    transport.enqueue({ ...event, eventId: 'second' });
    transport.enqueue({ ...event, eventId: 'third' });
    await transport.flush();

    // 400 不重试，直接丢弃并继续发送后面的批次。
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(transport.pending()).toBe(0);
    expect(transport.stats().dropped.rejected).toBe(1);
  });

  it('stops after the configured retry budget and keeps a failed batch queued', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('persistently offline'));
    const transport = createTransport({ batchSize: 1, fetchImpl });

    transport.enqueue(event);
    await transport.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(transport.pending()).toBe(1);
  });

  it('trims the oldest breadcrumbs of an oversized event instead of dropping it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createTransport({ fetchImpl });
    transport.enqueue(heavyEvent('oversized', 200));
    await transport.flush();

    const [sent] = sentEvents(fetchImpl.mock.calls[0]![1]!.body);
    expect(utf8Length(JSON.stringify(sent))).toBeLessThanOrEqual(32_000);
    expect(sent!.breadcrumbs.length).toBeLessThan(200);
    // 丢的是最旧的一端：离报错最近的操作保留下来。
    expect(sent!.breadcrumbs.at(-1)!.id).toBe('oversized-crumb-199');
    expect(sent!.payload.trimmedBreadcrumbs).toBe(200 - sent!.breadcrumbs.length);
  });

  it('truncates an enormous stack before giving up any breadcrumbs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createTransport({ fetchImpl });
    transport.enqueue({
      ...heavyEvent('long-stack', 5),
      payload: { message: 'deep recursion', stack: 'at frame (app.js:1:1)\n'.repeat(5_000) },
    });
    await transport.flush();

    const [sent] = sentEvents(fetchImpl.mock.calls[0]![1]!.body);
    expect(sent!.breadcrumbs).toHaveLength(5);
    expect(sent!.payload.truncated).toBe(true);
    expect(String(sent!.payload.stack)).toMatch(/…\[truncated\]$/);
  });

  it('hands the in-flight batch to the exit beacon and does not requeue it afterwards', async () => {
    // 早期实现把在途判断放在 beacon 分支之前：只要有一个普通 flush 在途，
    // pagehide 触发的 flush(true) 就直接返回那个 Promise，队列随页面一起消失。
    let failInFlight: (error: Error) => void = () => {};
    const fetchImpl = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          failInFlight = reject;
        }),
    );
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const transport = createTransport({ batchSize: 1, fetchImpl });

    transport.enqueue(event);
    const inFlight = transport.flush();
    // 第一批还挂在网络上时，又来了一条事件。
    transport.enqueue({ ...event, eventId: 'event-2' });

    await transport.flush(true);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect((await beaconEvents(sendBeacon)).map((item) => item.eventId)).toEqual([
      'event-1',
      'event-2',
    ]);
    expect(transport.pending()).toBe(0);

    // 页面卸载掐断了在途请求：它已经交给 beacon，不能再放回队列重复发送。
    failInFlight(new Error('aborted by unload'));
    await inFlight;
    expect(transport.pending()).toBe(0);
  });

  it('splits the exit flush into quota-sized beacons and persists what the browser refuses', async () => {
    // 浏览器对 beacon 在途数据只给约 64 KiB：第一块被接受，第二块因配额用尽被拒。
    const sendBeacon = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    vi.stubGlobal('navigator', { sendBeacon });
    const storage = memoryStorage();
    const transport = createTransport({ batchSize: 100, storage });

    for (let index = 0; index < 6; index += 1) transport.enqueue(heavyEvent(`exit-${index}`));
    await transport.flush(true);

    const firstBody = await (sendBeacon.mock.calls[0]![1] as Blob).text();
    expect(utf8Length(firstBody)).toBeLessThanOrEqual(60_000);
    expect((sendBeacon.mock.calls[0]![1] as Blob).type).toBe('text/plain;charset=utf-8');
    const accepted = (await beaconEvents(sendBeacon)).length;
    expect(accepted).toBeGreaterThan(0);

    const [copy, ...others] = persistedCopies(storage);
    expect(others).toHaveLength(0);
    expect(copy!.eventIds).toEqual(
      Array.from({ length: 6 - accepted }, (_, index) => `exit-${accepted + index}`),
    );
    // 标签页切到后台也会触发这条路径，页面未必真的卸载：持久化的事件仍留在队列里继续发送。
    expect(transport.pending()).toBe(6 - accepted);
  });

  it('resends events persisted at the previous exit and clears the copy once delivered', async () => {
    const storage = memoryStorage();
    storage.setItem(
      'tracepilot:pending:public-key',
      JSON.stringify([
        { ...event, eventId: 'left-over-1' },
        { ...event, eventId: 'left-over-2' },
      ]),
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createTransport({ storage, fetchImpl });

    transport.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // 等补发真正落定再断言和销毁；否则 destroy 会把仍在途的批次交给退出路径。
    await transport.flush();
    expect(sentEvents(fetchImpl.mock.calls[0]![1]!.body).map((item) => item.eventId)).toEqual([
      'left-over-1',
      'left-over-2',
    ]);
    expect(persistedCopies(storage)).toHaveLength(0);
    transport.destroy();
  });

  it('keeps one persisted copy per tab so tabs closing together do not overwrite each other', async () => {
    // 回归：副本曾只按接入键存一份。两个标签页都开着、先后关闭时，后关闭的覆盖了先关闭的，
    // 前一个标签页发不完的事件就此丢失。
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) });
    const storage = memoryStorage();
    const first = createTransport({ batchSize: 100, storage });
    const second = createTransport({ batchSize: 100, storage });
    first.start();
    second.start();
    first.enqueue({ ...event, eventId: 'tab-a' });
    second.enqueue({ ...event, eventId: 'tab-b' });

    first.destroy();
    second.destroy();
    expect(persistedCopies(storage).map((copy) => copy.eventIds)).toEqual([['tab-a'], ['tab-b']]);

    // 下一次加载补发所有标签页的副本（包括旧版本不带实例编号的键），然后删掉它们。
    storage.setItem(
      'tracepilot:pending:public-key',
      JSON.stringify([{ ...event, eventId: 'legacy' }]),
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const next = createTransport({ storage, fetchImpl });
    next.start();
    await next.flush();
    expect(
      sentEvents(fetchImpl.mock.calls[0]![1]!.body)
        .map((item) => item.eventId)
        .sort(),
    ).toEqual(['legacy', 'tab-a', 'tab-b']);
    expect(persistedCopies(storage)).toHaveLength(0);
    next.destroy();
  });

  it('clears only its own persisted copy once its queue drains', async () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) });
    const storage = memoryStorage();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const background = createTransport({ batchSize: 100, storage, fetchImpl });
    background.enqueue({ ...event, eventId: 'background-tab' });
    // 切到后台：发不出去的事件写进副本，但仍留在队列里。
    await background.flush(true);
    // 另一个标签页随后关闭，留下自己的副本。
    const closing = createTransport({ batchSize: 100, storage });
    closing.enqueue({ ...event, eventId: 'closed-tab' });
    closing.destroy();

    // 回到前台后排空队列，只删自己的副本，不能把别的标签页刚存下的删掉。
    await background.flush();
    expect(persistedCopies(storage).map((copy) => copy.eventIds)).toEqual([['closed-tab']]);
  });

  it('backs off automatic sends after a failure but still lets an explicit flush through', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createTransport({ batchSize: 1, fetchImpl });

    transport.enqueue({ ...event, eventId: 'first' });
    await vi.waitFor(() => expect(transport.stats().lastFailure).not.toBeNull());
    const { nextAttemptAt } = transport.stats();
    expect(nextAttemptAt).toBeGreaterThan(Date.now());

    // 退避期内，攒够一批也不会自动发送。
    transport.enqueue({ ...event, eventId: 'second' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(transport.pending()).toBe(2);

    // 调用方显式 flush 不受退避约束；送达后退避清零（batchSize 为 1，两条各发一次）。
    await transport.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(transport.stats()).toMatchObject({ pending: 0, delivered: 2, nextAttemptAt: null });
  });

  it('does not retry a rate-limited batch at once and honours Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '30' } }));
    const transport = createTransport({ maxRetries: 2, fetchImpl });
    transport.enqueue(event);
    await transport.flush();

    // 429 不做同一轮里的快速重试。
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { nextAttemptAt, lastFailure } = transport.stats();
    expect(lastFailure?.status).toBe(429);
    expect(nextAttemptAt).toBeGreaterThanOrEqual(Date.now() + 29_000);

    // 服务端要求的等待连显式 flush 也要遵守。
    await transport.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(transport.pending()).toBe(1);
  });

  it('caps the queue so an error storm cannot grow it without bound', () => {
    const transport = createTransport({
      batchSize: 100,
      maxQueueSize: 10,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
    });

    for (let index = 0; index < 25; index += 1) {
      transport.enqueue({ ...event, eventId: `storm-${index}` });
    }

    expect(transport.pending()).toBe(10);
    expect(transport.dropped()).toBe(15);
    expect(transport.stats().dropped.queueFull).toBe(15);
  });

  it('normalizes an invalid zero batch size before flushing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createTransport({
      batchSize: 0,
      flushInterval: 0,
      maxRetries: -2,
      fetchImpl,
    });

    transport.enqueue(event);
    await transport.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).events).toHaveLength(1);
    expect(transport.pending()).toBe(0);
  });

  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('结账')).toBe(6);
    expect(utf8Length('😀')).toBe(4);
  });
});
