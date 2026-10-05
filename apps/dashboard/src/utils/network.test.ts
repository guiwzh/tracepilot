import { describe, expect, it } from 'vitest';
import { requestOutcome } from './network';

describe('requestOutcome', () => {
  it('names network errors, cancellations and business failures instead of a bare status', () => {
    expect(requestOutcome({ status: 503, success: false })).toBe('HTTP 503');
    expect(requestOutcome({ status: 0, success: false, error: 'Failed to fetch' })).toBe(
      'network error: Failed to fetch',
    );
    expect(requestOutcome({ status: 0, success: false, aborted: true })).toBe('aborted');
    expect(
      requestOutcome({
        status: 200,
        success: false,
        businessCode: 40012,
        businessMessage: 'Coupon expired',
      }),
    ).toBe('HTTP 200 · code 40012: Coupon expired');
    // no-cors 的 opaque 响应状态码也是 0，但它不是网络错误。
    expect(requestOutcome({ status: 0, success: true })).toBe('HTTP 0');
  });
});
