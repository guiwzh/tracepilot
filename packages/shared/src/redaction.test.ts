import { describe, expect, it } from 'vitest';
import { redactPayload, redactSensitive, redactStack, stripUrlQuery } from './redaction';

// 隐私测试既覆盖结构化 URL 字段，也覆盖嵌在错误消息中的 URL。
describe('privacy helpers', () => {
  it('removes URL query and fragment values', () => {
    expect(stripUrlQuery('https://shop.test/pay?token=secret#step')).toBe('https://shop.test/pay');
  });

  it('keeps a hash route but drops its parameters and any other fragment', () => {
    // hash 路由的应用（/#/cart）靠片段区分页面；路由自己的参数和其他片段（令牌、页内锚点）照样去掉。
    expect(stripUrlQuery('https://shop.test/app?token=1#/checkout?coupon=A')).toBe(
      'https://shop.test/app#/checkout',
    );
    expect(stripUrlQuery('/app#!/orders/42')).toBe('/app#!/orders/42');
    expect(stripUrlQuery('/app#/callback&access_token=abc')).toBe('/app#/callback');
    expect(stripUrlQuery('https://shop.test/callback#access_token=abc&state=1')).toBe(
      'https://shop.test/callback',
    );
    expect(stripUrlQuery('/docs#reviews')).toBe('/docs');
    expect(
      redactSensitive({
        route: '/app#/cart?step=2',
        message: 'Blank page on /app#/checkout?step=2',
        data: { url: 'https://shop.test/app#access_token=abc' },
      }),
    ).toEqual({
      route: '/app#/cart',
      message: 'Blank page on /app#/checkout',
      data: { url: 'https://shop.test/app' },
    });
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

describe('stack redaction', () => {
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

  it('applies the stack rule to stack fields and the shared rules to everything else', () => {
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
