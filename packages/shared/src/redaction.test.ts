import { describe, expect, it } from 'vitest';
import { redactSensitive, stripUrlQuery } from './redaction';

describe('privacy helpers', () => {
  it('removes URL query and fragment values', () => {
    expect(stripUrlQuery('https://shop.test/pay?token=secret#step')).toBe('https://shop.test/pay');
  });

  it('redacts sensitive keys at any depth', () => {
    expect(redactSensitive({ headers: { Authorization: 'Bearer abc' }, password: '123' })).toEqual({
      headers: { Authorization: '[REDACTED]' },
      password: '[REDACTED]',
    });
  });

  it('removes arbitrary query and fragment values from URL fields and telemetry text', () => {
    expect(
      redactSensitive({
        requestUrl: 'https://api.test/orders?campaign=private#receipt',
        message: 'GET https://api.test/orders?campaign=private → 503',
        nested: { url: '/checkout?experiment=variant-a' },
      }),
    ).toEqual({
      requestUrl: 'https://api.test/orders',
      message: 'GET https://api.test/orders → 503',
      nested: { url: '/checkout' },
    });
  });
});
