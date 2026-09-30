import { describe, expect, it } from 'vitest';
import { isFailedRequest } from './requests';

describe('failed requests in evidence', () => {
  it('counts HTTP errors, network errors and business failures', () => {
    expect(isFailedRequest({ status: 503, success: false })).toBe(true);
    // 4xx 默认不单独成为事件，但排查时仍是证据。
    expect(isFailedRequest({ status: 404, success: true })).toBe(true);
    expect(isFailedRequest({ status: 0, success: false, error: 'Failed to fetch' })).toBe(true);
    expect(isFailedRequest({ status: 200, success: false, businessCode: 40012 })).toBe(true);
  });

  it('leaves successful, cancelled and opaque requests alone', () => {
    expect(isFailedRequest({ status: 200, success: true })).toBe(false);
    expect(isFailedRequest({ status: 0, success: false, aborted: true })).toBe(false);
    // no-cors 的 opaque 响应状态码固定为 0，SDK 把它记为成功。
    expect(isFailedRequest({ status: 0, success: true })).toBe(false);
    expect(isFailedRequest(undefined)).toBe(false);
  });
});
