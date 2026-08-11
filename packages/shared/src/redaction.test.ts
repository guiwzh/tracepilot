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
});
