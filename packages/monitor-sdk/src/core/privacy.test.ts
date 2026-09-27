import { describe, expect, it } from 'vitest';
import { redactPayload, redactStack } from './privacy';

describe('SDK-side redaction', () => {
  it('strips queries from stack frames but keeps the line and column numbers', () => {
    // 通用的文本规则会把 "app.js?v=3:1:420)" 从问号起整段删掉，服务端就无法再还原这一帧。
    expect(
      redactStack(
        [
          'TypeError: Failed to load https://api.test/cart?token=secret',
          '    at load (https://cdn.test/app.js?v=3:1:420)',
          '    at https://cdn.test/vendor.js?t=99#hash:2:15',
          'submit@https://cdn.test/app.js?v=3:9:1',
        ].join('\n'),
      ).split('\n'),
    ).toEqual([
      'TypeError: Failed to load https://api.test/cart',
      '    at load (https://cdn.test/app.js:1:420)',
      '    at https://cdn.test/vendor.js:2:15',
      'submit@https://cdn.test/app.js:9:1',
    ]);
  });

  it('applies the shared rules to everything else in a payload', () => {
    expect(
      redactPayload({
        url: 'https://api.test/orders?campaign=private',
        message: 'GET https://api.test/orders?campaign=private → 503',
        password: 'hunter2',
        componentStack: '\n    at Cart (https://cdn.test/app.js?v=3:4:2)',
        count: 3,
      }),
    ).toEqual({
      url: 'https://api.test/orders',
      message: 'GET https://api.test/orders → 503',
      password: '[REDACTED]',
      componentStack: '\n    at Cart (https://cdn.test/app.js:4:2)',
      count: 3,
    });
  });
});
