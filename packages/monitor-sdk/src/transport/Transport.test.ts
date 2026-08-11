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
