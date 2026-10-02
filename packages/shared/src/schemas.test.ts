import { describe, expect, it } from 'vitest';
import { monitorEventSchema } from './schemas';

const event = {
  eventId: 'e1',
  eventType: 'error',
  timestamp: 1,
  projectId: 'demo-project',
  release: '1.0.0',
  environment: 'production',
  page: { url: 'https://shop.test/' },
  device: { userAgent: 'Chrome/140' },
  payload: {},
  breadcrumbs: [],
};

describe('event trace ids', () => {
  it('accepts a W3C trace id and rejects anything else', () => {
    const valid = (traceId: unknown) => monitorEventSchema.safeParse({ ...event, traceId }).success;
    expect(valid(undefined)).toBe(true);
    expect(valid('0af7651916cd43dd8448eb211c80319c')).toBe(true);
    // 规范要求小写；全 0 是无效值；长度必须是 32。
    expect(valid('0AF7651916CD43DD8448EB211C80319C')).toBe(false);
    expect(valid('00000000000000000000000000000000')).toBe(false);
    expect(valid('0af7651916cd43dd8448eb211c80319')).toBe(false);
    expect(valid('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBe(false);
  });
});
