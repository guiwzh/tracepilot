import { describe, expect, it, vi } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { Transport } from './Transport';

// 注入假的 fetch 让重试路径完全可控，不依赖真实网络。
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

describe('Transport', () => {
  it('retries a failed batch and preserves the envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const transport = new Transport({
      endpoint: 'https://ingest.test/envelopes',
      dsnKey: 'public-key',
      batchSize: 10,
      flushInterval: 60_000,
      maxRetries: 1,
      fetchImpl,
    });
    transport.enqueue(event);
    await transport.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).toMatchObject({
      dsnKey: 'public-key',
      events: [{ eventId: 'event-1' }],
    });
    expect(transport.pending()).toBe(0);
  });

  it('stops after the configured retry budget and keeps a failed full batch queued', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('persistently offline'));
    const transport = new Transport({
      endpoint: 'https://ingest.test/envelopes',
      dsnKey: 'public-key',
      batchSize: 1,
      flushInterval: 60_000,
      maxRetries: 0,
      fetchImpl,
    });

    transport.enqueue(event);
    await transport.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(transport.pending()).toBe(1);
  });

  it('sends the queue by beacon on page exit even while a request is in flight', async () => {
    // 早期实现把 inFlight 判断放在 beacon 分支之前：只要有一个普通 flush 在途，
    // pagehide 触发的 flush(true) 就直接返回那个 Promise，队列随页面一起消失。
    let releaseInFlight: (value: Response) => void = () => {};
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolveFetch) => {
            releaseInFlight = resolveFetch;
          }),
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });

    const transport = new Transport({
      endpoint: 'https://ingest.test/envelopes',
      dsnKey: 'public-key',
      batchSize: 1,
      flushInterval: 60_000,
      maxRetries: 0,
      fetchImpl,
    });

    transport.enqueue(event);
    const inFlight = transport.flush();
    // 第一批还挂在网络上时，又来了一条事件。
    transport.enqueue({ ...event, eventId: 'event-2' });

    await transport.flush(true);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(transport.pending()).toBe(0);

    releaseInFlight(new Response(null, { status: 202 }));
    await inFlight;
    vi.unstubAllGlobals();
  });

  it('drains every queued batch through beacon, not just the first', async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const transport = new Transport({
      endpoint: 'https://ingest.test/envelopes',
      dsnKey: 'public-key',
      batchSize: 2,
      flushInterval: 60_000,
      maxRetries: 0,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
    });

    for (let index = 0; index < 6; index += 1) {
      transport.enqueue({ ...event, eventId: `event-${index}` });
    }
    // enqueue 到达 batchSize 会触发普通 flush；服务端不可达时这些批次会被放回队列。
    // 先等它们全部落定，再验证退出路径，否则断言会和后台 flush 抢队列。
    await vi.waitFor(() => expect(transport.pending()).toBe(6));

    await transport.flush(true);

    // 6 条事件 / 每批 2 条 = 3 次 beacon，而不是只发首批就收工。
    expect(sendBeacon).toHaveBeenCalledTimes(3);
    expect(transport.pending()).toBe(0);
    vi.unstubAllGlobals();
  });

  it('caps the queue so an error storm cannot grow it without bound', () => {
    const transport = new Transport({
      endpoint: 'https://ingest.test/envelopes',
      dsnKey: 'public-key',
      batchSize: 100,
      flushInterval: 60_000,
      maxRetries: 0,
      maxQueueSize: 10,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
    });

    for (let index = 0; index < 25; index += 1) {
      transport.enqueue({ ...event, eventId: `storm-${index}` });
    }

    expect(transport.pending()).toBe(10);
    expect(transport.dropped()).toBe(15);
  });

  it('normalizes an invalid zero batch size before flushing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = new Transport({
      endpoint: 'https://ingest.test/envelopes',
      dsnKey: 'public-key',
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
});
