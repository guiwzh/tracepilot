import { currentRoute } from '../core/helpers';
import { watchHistory } from '../core/history';
import type { MonitorPlugin, PluginContext, WhiteScreenOptions } from '../types';

/**
 * 白屏检测：页面加载完成、或单页应用切换路由之后，页面在一段时间里始终是空的。
 *
 * 白屏往往没有任何 JS 报错（接口返回了空数据、样式把内容盖住、渲染条件永远不满足），只靠错误监控看不到。
 * 做法与腾讯 Aegis 等国内 SDK 的采样点方案相同：在视口的水平、垂直两条中线上各取 9 个点，用
 * elementFromPoint 看每个点最上层的元素。落在 html、body、#root 这类容器上、或者落在骨架屏里，
 * 这个点就是空的；所有点都空才算白屏。
 *
 * 为什么不用另外两种方案：
 * - MutationObserver 看 DOM 有没有内容：DOM 里有节点不代表用户看得见（被隐藏、尺寸为 0、被遮住）。
 * - 截图看像素：要把页面画到 canvas 上，开销大，还涉及隐私，只适合在出问题之后辅助排查。
 *
 * 误报控制：加载中的页面本来就可能暂时空白，所以一次空白不算，要连续 checks 次（间隔 interval）
 * 都是空的才上报；页面在后台时暂停，回到前台再从头检测；同一路由在一次页面访问里只报一次。
 */
const DEFAULT_CONTAINERS = ['html', 'body', '#root', '#app', '#__next', '#__nuxt'];
const DEFAULT_INTERVAL = 1_000;
const DEFAULT_CHECKS = 5;

/**
 * 丢掉浏览器不认识的选择器，拼成一个；matches 遇到非法选择器会抛错。
 * 在空的文档片段上查询：只解析选择器，不遍历页面。
 */
function selectorList(selectors: readonly string[]): string {
  const fragment = document.createDocumentFragment();
  return selectors
    .filter((selector) => {
      try {
        fragment.querySelector(selector);
        return true;
      } catch {
        return false;
      }
    })
    .join(',');
}

/** 非法的数字（NaN、Infinity、不是数字）用默认值；再取整，不低于下限。 */
function atLeast(value: unknown, fallback: number, minimum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.floor(number));
}

export class WhiteScreenPlugin implements MonitorPlugin {
  readonly name = 'WhiteScreenPlugin';
  private context?: PluginContext;
  private containers = '';
  private skeletons = '';
  private interval = DEFAULT_INTERVAL;
  private checks = DEFAULT_CHECKS;
  private timer?: ReturnType<typeof setTimeout>;
  private lastRoute?: string;
  // 页面在后台时暂停的那一轮检测由什么触发；回到前台后据此重新开始。
  private paused?: 'load' | 'route';
  // 同一路由在一次页面访问里只报一次：用户停在白屏上，不会每换一次路由就重复一遍。
  private readonly reported = new Set<string>();
  private stopWatchingHistory?: () => void;
  private readonly onLoad = () => this.detect('load');
  private readonly onPopState = () => this.onRouteChange();
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && this.paused) this.detect(this.paused);
  };

  setup(context: PluginContext): void {
    if (this.context || typeof window === 'undefined' || typeof document === 'undefined') return;
    const config: WhiteScreenOptions | false = context.options.whiteScreen ?? {};
    if (config === false || typeof document.elementFromPoint !== 'function') return;
    this.context = context;
    this.containers = selectorList(config.containers ?? DEFAULT_CONTAINERS);
    this.skeletons = selectorList(config.skeletons ?? []);
    this.interval = atLeast(config.interval, DEFAULT_INTERVAL, 100);
    this.checks = atLeast(config.checks, DEFAULT_CHECKS, 1);
    this.lastRoute = currentRoute();
    if (document.readyState === 'complete') this.detect('load');
    else window.addEventListener('load', this.onLoad, { once: true });
    window.addEventListener('popstate', this.onPopState);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.stopWatchingHistory = watchHistory(() => this.onRouteChange());
  }

  /** 只在路径或 hash 真的变化时重新检测；只改查询参数的 replaceState 不算换页面。 */
  private onRouteChange(): void {
    const route = currentRoute();
    if (route === this.lastRoute) return;
    this.lastRoute = route;
    this.detect('route');
  }

  private detect(trigger: 'load' | 'route'): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.paused = undefined;
    const route = currentRoute();
    if (this.reported.has(route)) return;
    let blank = 0;
    const check = () => {
      this.timer = undefined;
      const context = this.context;
      // 路由又变了，由新一轮检测负责；视口没有尺寸（隐藏的 iframe）时无从判断。
      if (!context || currentRoute() !== route || !window.innerWidth || !window.innerHeight) return;
      // 后台标签页不绘制，依赖 requestAnimationFrame 的渲染也会停下，这时的空白不说明问题。
      // 暂停这一轮，回到前台从头再查；从后台打开的标签页因此也能检测到。
      if (document.visibilityState === 'hidden') {
        this.paused = trigger;
        return;
      }
      const { empty, total } = this.sample();
      if (empty < total) return;
      blank += 1;
      if (blank < this.checks) {
        this.timer = setTimeout(check, this.interval);
        return;
      }
      this.reported.add(route);
      context.captureEvent('error', {
        name: 'WhiteScreen',
        message: `Blank page on ${route}`,
        level: 'error',
        mechanism: 'white-screen',
        trigger,
        emptyPoints: empty,
        totalPoints: total,
        blankForMs: this.checks * this.interval,
      });
    };
    this.timer = setTimeout(check, this.interval);
  }

  /** 视口两条中线上的 18 个采样点（中心点重复一次），数出其中空着的点。 */
  private sample(): { empty: number; total: number } {
    const width = window.innerWidth;
    const height = window.innerHeight;
    let empty = 0;
    let total = 0;
    for (let index = 1; index <= 9; index += 1) {
      for (const [x, y] of [
        [(width * index) / 10, height / 2],
        [width / 2, (height * index) / 10],
      ] as const) {
        total += 1;
        if (this.isEmptyAt(x, y)) empty += 1;
      }
    }
    return { empty, total };
  }

  private isEmptyAt(x: number, y: number): boolean {
    const element = document.elementFromPoint(x, y);
    if (!element) return true;
    if (this.containers && element.matches(this.containers)) return true;
    return this.skeletons !== '' && element.closest(this.skeletons) !== null;
  }

  teardown(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (typeof window !== 'undefined') {
      window.removeEventListener('load', this.onLoad);
      window.removeEventListener('popstate', this.onPopState);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.stopWatchingHistory?.();
    this.stopWatchingHistory = undefined;
    this.paused = undefined;
    this.reported.clear();
    this.context = undefined;
  }
}
