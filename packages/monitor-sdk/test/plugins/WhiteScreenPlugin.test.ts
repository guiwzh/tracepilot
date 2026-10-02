import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveOptions } from '../../src/core/options';
import { WhiteScreenPlugin } from '../../src/plugins/WhiteScreenPlugin';
import type { CapturePayload, PluginContext, WhiteScreenOptions } from '../../src/types';
import { TraceContext } from '../../src/core/trace';

/** 视口里最上层的元素由测试决定：返回 body 表示这个点是空的。 */
let topElement: () => Element | null = () => document.body;
const originalElementFromPoint = document.elementFromPoint;
const originalPushState = history.pushState;
let plugin: WhiteScreenPlugin | undefined;

function install(whiteScreen: WhiteScreenOptions | false = { interval: 100, checks: 3 }) {
  const events: CapturePayload[] = [];
  const context: PluginContext = {
    options: resolveOptions({
      dsn: 'https://ingest.test/api/v1/envelopes',
      projectId: 'test-project',
      release: '1.0.0',
      environment: 'test',
      whiteScreen,
    }),
    captureEvent: (_type, payload) => {
      events.push(payload);
      return 'event-id';
    },
    addBreadcrumb: () => {},
    startRequestSpan: () => new TraceContext().startRequestSpan(),
  };
  plugin = new WhiteScreenPlugin();
  plugin.setup(context);
  return events;
}

function content(): Element {
  const main = document.createElement('main');
  main.textContent = 'Checkout';
  document.body.append(main);
  return main;
}

beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState({}, '', '/');
  topElement = () => document.body;
  document.elementFromPoint = (() => topElement()) as typeof document.elementFromPoint;
});

afterEach(() => {
  plugin?.teardown();
  plugin = undefined;
  document.elementFromPoint = originalElementFromPoint;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('WhiteScreenPlugin', () => {
  it('reports a page that stays blank through every check', () => {
    const events = install();

    // 一次空白不算：加载中的页面本来就可能暂时空白。
    vi.advanceTimersByTime(299);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([
      {
        name: 'WhiteScreen',
        message: 'Blank page on /',
        level: 'error',
        mechanism: 'white-screen',
        trigger: 'load',
        emptyPoints: 18,
        totalPoints: 18,
        blankForMs: 300,
      },
    ]);
    // 同一路由只报一次。
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(1);
  });

  it('stays quiet once content shows up before the last check', () => {
    const events = install();
    vi.advanceTimersByTime(100);
    const main = content();
    topElement = () => main;
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);
  });

  it('counts a skeleton that never goes away as blank', () => {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    const bar = document.createElement('span');
    skeleton.append(bar);
    document.body.append(skeleton);
    topElement = () => bar;

    const events = install({ interval: 100, checks: 3, skeletons: ['.skeleton'] });
    vi.advanceTimersByTime(300);
    expect(events.map((event) => event.message)).toEqual(['Blank page on /']);
  });

  it('checks again after an SPA route change and reports each blank route once', () => {
    const main = content();
    topElement = () => main;
    const events = install();
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);

    // 新路由渲染失败：页面只剩空的容器。
    topElement = () => document.body;
    history.pushState({}, '', '/checkout/blank');
    vi.advanceTimersByTime(300);
    // 只改查询参数不算换页面，不会重新检测，也不会重复上报。
    history.replaceState({}, '', '/checkout/blank?step=2');
    vi.advanceTimersByTime(1_000);
    history.pushState({}, '', '/cart');
    vi.advanceTimersByTime(300);
    history.pushState({}, '', '/checkout/blank');
    vi.advanceTimersByTime(1_000);

    expect(events.map((event) => [event.message, event.trigger])).toEqual([
      ['Blank page on /checkout/blank', 'route'],
      ['Blank page on /cart', 'route'],
    ]);
  });

  it('pauses in the background and checks again once the page is visible', () => {
    // 后台标签页不绘制，空白不说明问题；但从后台打开的标签页切到前台之后仍要检测。
    let state: DocumentVisibilityState = 'hidden';
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    const events = install();
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);

    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(299);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events.map((event) => event.trigger)).toEqual(['load']);
    visibility.mockRestore();
  });

  it('does not judge a viewport without size, such as a hidden iframe', () => {
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 0 });
    try {
      const events = install();
      vi.advanceTimersByTime(1_000);
      expect(events).toEqual([]);
    } finally {
      if (width) Object.defineProperty(window, 'innerWidth', width);
      else delete (window as { innerWidth?: number }).innerWidth;
    }
  });

  it('falls back to the defaults for settings it cannot use', () => {
    // interval 为 NaN 时 setTimeout 会立即触发，checks 为 NaN 时第一次空白就上报：页面还在加载就会误报。
    const events = install({
      interval: Number.NaN,
      checks: Number.NaN,
      containers: ['body', '::not-a-selector(('],
    });
    vi.advanceTimersByTime(4_999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toMatchObject([{ emptyPoints: 18, blankForMs: 5_000 }]);
  });

  it('can be switched off and stops checking on teardown', () => {
    expect(install(false)).toEqual([]);
    vi.advanceTimersByTime(1_000);
    plugin!.teardown();

    const events = install();
    history.pushState({}, '', '/checkout');
    plugin!.teardown();
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);
    expect(history.pushState).toBe(originalPushState);
  });
});
