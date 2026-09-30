import { describe, expect, it } from 'vitest';
import { isFailedRequest as sharedRule } from '@trace-pilot/shared';
import { isFailedRequest, requestOutcome } from './network';

describe('isFailedRequest', () => {
  it('agrees with the shared rule the server uses', () => {
    // 工作台为了不把 zod 打进包里自己复制了一份规则；两份必须一致。
    const cases: Array<Record<string, unknown> | undefined> = [
      { status: 200, success: true },
      { status: 404, success: true },
      { status: 503, success: false },
      { status: 0, success: false, error: 'Failed to fetch' },
      { status: 0, success: false, aborted: true },
      { status: 0, success: true },
      { status: 200, success: false, businessCode: 40012 },
      undefined,
    ];
    expect(cases.map(isFailedRequest)).toEqual(cases.map(sharedRule));
  });
});

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
