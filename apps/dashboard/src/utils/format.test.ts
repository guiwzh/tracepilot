import { describe, expect, it } from 'vitest';
import { metricValue } from './format';

describe('metricValue', () => {
  it('keeps CLS unitless and formats timing metrics in milliseconds', () => {
    expect(metricValue('CLS', 0.08192)).toBe('0.082');
    expect(metricValue('LCP', 2399.7)).toBe('2400 ms');
  });
});
