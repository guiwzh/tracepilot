import { describe, expect, it } from 'vitest';
import { traceUrl } from './trace';

describe('traceUrl', () => {
  it('fills the trace and span into the configured template, or gives nothing without one', () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    expect(
      traceUrl(
        traceId,
        'b7ad6b7169203331',
        'http://localhost:16686/trace/{traceId}?uiFind={spanId}',
      ),
    ).toBe('http://localhost:16686/trace/0af7651916cd43dd8448eb211c80319c?uiFind=b7ad6b7169203331');
    expect(traceUrl(traceId, undefined, 'https://tempo.example/{traceId}')).toBe(
      'https://tempo.example/0af7651916cd43dd8448eb211c80319c',
    );
    expect(traceUrl(traceId, undefined, '')).toBeNull();
  });
});
