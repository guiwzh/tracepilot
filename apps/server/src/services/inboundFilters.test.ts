import { describe, expect, it } from 'vitest';
import type { MonitorEvent } from '@trace-pilot/shared';
import { inboundFilter } from './inboundFilters';
import { DEFAULT_PROJECT_SETTINGS } from './projectSettings';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function error(
  overrides: Partial<MonitorEvent> = {},
  payload: Record<string, unknown> = {},
): MonitorEvent {
  return {
    eventId: 'e',
    eventType: 'error',
    timestamp: 1,
    projectId: 'p',
    release: '2.4.1',
    environment: 'production',
    page: { url: 'https://shop.example/checkout' },
    device: { userAgent: CHROME },
    payload: {
      name: 'TypeError',
      message: 'Cannot read cart',
      stack: 'TypeError: Cannot read cart\n    at submit (https://shop.example/assets/app.js:1:10)',
      ...payload,
    },
    breadcrumbs: [],
    ...overrides,
  };
}

const defaults = inboundFilter(DEFAULT_PROJECT_SETTINGS.inboundFilters);

describe('inbound filters', () => {
  it('keeps an ordinary application error', () => {
    expect(defaults(error())).toBeNull();
  });

  it('drops errors thrown from a browser extension, but not ones that only passed through it', () => {
    const fromExtension = error(
      {},
      {
        stack:
          'TypeError: x\n    at inject (chrome-extension://abcdef/content.js:3:9)\n    at https://shop.example/assets/app.js:1:10',
      },
    );
    expect(defaults(fromExtension)).toBe('browser-extension');
    expect(
      defaults(error({}, { filename: 'moz-extension://1234/inject.js', stack: undefined })),
    ).toBe('browser-extension');
    // 扩展调用了应用的代码、在应用里出错：栈顶是应用自己的帧，这是应用的 bug。
    const throughExtension = error(
      {},
      {
        stack:
          'TypeError: x\n    at submit (https://shop.example/assets/app.js:1:10)\n    at chrome-extension://abcdef/content.js:3:9',
      },
    );
    expect(defaults(throughExtension)).toBeNull();
  });

  it('drops crawlers, but not headless browsers used by automated tests', () => {
    const bot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    expect(defaults(error({ device: { userAgent: bot } }))).toBe('web-crawler');
    // 爬虫上报的性能样本同样会把 Web Vitals 带偏。
    expect(defaults(error({ eventType: 'performance', device: { userAgent: bot } }))).toBe(
      'web-crawler',
    );
    const headless =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
    expect(defaults(error({ device: { userAgent: headless } }))).toBeNull();
  });

  it('drops localhost only when asked to', () => {
    const local = error({ page: { url: 'http://localhost:5173/checkout' } });
    expect(defaults(local)).toBeNull();
    const filter = inboundFilter({ ...DEFAULT_PROJECT_SETTINGS.inboundFilters, localhost: true });
    expect(filter(local)).toBe('localhost');
    expect(filter(error({ page: { url: 'http://127.0.0.1:4174/' } }))).toBe('localhost');
    expect(filter(error())).toBeNull();
  });

  it('matches message and release patterns with * wildcards', () => {
    const filter = inboundFilter({
      ...DEFAULT_PROJECT_SETTINGS.inboundFilters,
      errorMessages: ['*cannot read CART*', 'ChunkLoadError: *'],
      releases: ['1.*'],
    });
    // 消息不区分大小写，按「类型: 消息」或消息本身匹配。
    expect(filter(error())).toBe('error-message');
    expect(filter(error({}, { name: 'ChunkLoadError', message: 'Loading chunk 7 failed' }))).toBe(
      'error-message',
    );
    expect(filter(error({}, { message: 'Payment declined' }))).toBeNull();
    expect(filter(error({ release: '1.9.0' }, { message: 'Payment declined' }))).toBe('release');
    expect(filter(error({ release: '11.0' }, { message: 'Payment declined' }))).toBeNull();
    // 正则的特殊字符按字面匹配。
    const literal = inboundFilter({
      ...DEFAULT_PROJECT_SETTINGS.inboundFilters,
      errorMessages: ['a.b (c)'],
    });
    expect(literal(error({}, { message: 'a.b (c)' }))).toBe('error-message');
    expect(literal(error({}, { message: 'axb (c)' }))).toBeNull();
  });

  it('lets everything through when every filter is off', () => {
    const off = inboundFilter({
      browserExtensions: false,
      webCrawlers: false,
      localhost: false,
      errorMessages: [],
      releases: [],
    });
    const bot = 'Mozilla/5.0 (compatible; bingbot/2.0)';
    expect(
      off(error({ device: { userAgent: bot } }, { stack: 'x\n at chrome-extension://a/b.js:1:1' })),
    ).toBeNull();
  });
});
