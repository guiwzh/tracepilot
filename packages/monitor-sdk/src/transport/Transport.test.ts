import { describe, expect, it, vi } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { Transport } from './Transport';

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
});
