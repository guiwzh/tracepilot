import { afterEach, beforeEach, vi } from 'vitest';

/**
 * happy-dom 的 sendBeacon 和 fetch 会发出真实的网络请求。核心销毁时会冲刷传输队列，
 * 不替换的话每个用例都会去连本机端口，失败的 Promise 没人处理，变成测试里的未处理异常。
 * 每个用例默认换成不出网的替身；需要观察发送内容的用例再自己覆盖。
 *
 * 用直接赋值而不是 vi.spyOn：spyOn 会把属性换成 getter/setter，之后再给 window.fetch 赋值
 * 只会改掉替身的实现、属性本身不变。NetworkPlugin 这类包装全局 API 的代码在测试里就和浏览器不一样了。
 */
const originalFetch = window.fetch;
const originalSendBeacon = navigator.sendBeacon;

beforeEach(() => {
  window.fetch = vi.fn(async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
  navigator.sendBeacon = vi.fn(() => true);
});

afterEach(() => {
  window.fetch = originalFetch;
  navigator.sendBeacon = originalSendBeacon;
});
