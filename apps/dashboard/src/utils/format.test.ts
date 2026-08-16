import { describe, expect, it } from 'vitest';
import { metricValue } from './format';

// 展示层格式化保持小而确定，单测锁定 CLS 与毫秒单位的差异。
describe('metricValue', () => {
  it('keeps CLS unitless and formats timing metrics in milliseconds', () => {
    expect(metricValue('CLS', 0.08192)).toBe('0.082');
    expect(metricValue('LCP', 2399.7)).toBe('2400 ms');
  });
});
