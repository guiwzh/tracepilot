import type { MonitorEvent } from '@trace-pilot/shared';
import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
  type MetricWithAttribution,
} from 'web-vitals/attribution';
import { getPageContext } from '../core/helpers';
import type { MonitorPlugin, PluginContext } from '../types';

/**
 * 指标的计算交给 Google 官方的 web-vitals 库，本插件只决定「什么时候、以什么形式」上报。
 *
 * 早期版本自己用 PerformanceObserver 计算，三个口径都是错的：CLS 把所有偏移直接累加
 * （现行定义是按会话窗口取最大值），INP 取了所有 event 条目的最大时长（应只看带
 * interactionId 的交互、按交互分组后取高分位），LCP 在用户首次输入后仍在更新。
 * 这些规则还在演进（2024 年 INP 取代了 FID），跟着官方库走比自己维护可靠。
 *
 * 用的是它的归因（attribution）版本：除了数值，还给出造成指标的元素和拆分后的几段耗时，
 * 「LCP 慢」才能落到「哪张图、慢在下载还是渲染」。代价是接入方的包多约 2.3 KB gzip。
 *
 * web-vitals 的 onXXX 没有注销 API，注册的 PerformanceObserver 和监听器会存活到页面结束。
 * 如果每次 setup 都注册一遍，SPA 里反复 start/destroy 会让它们无限累积。
 * 所以整页只注册一次（模块级单例），插件实例只是这个分发中心的订阅者。
 */

/** 一次指标更新，连同它发生时所在的页面。 */
interface Sample {
  metric: MetricWithAttribution;
  page: MonitorEvent['page'];
}
type Subscriber = (sample: Sample) => void;

const subscribers = new Set<Subscriber>();
const latest = new Map<MetricWithAttribution['name'], Sample>();
let registered = false;

function registerOnce(): void {
  if (registered) return;
  registered = true;
  const forward = (metric: MetricWithAttribution) => {
    // 在指标变化的那一刻记下页面。LCP、CLS、INP 要等页面隐藏时才上报，单页应用里那时可能已经换了
    // 好几次路由；用上报时的页面，这次访问的指标就会被算到用户最后停留的那个路由上。
    const sample = { metric, page: getPageContext() };
    latest.set(metric.name, sample);
    for (const subscriber of subscribers) subscriber(sample);
  };
  // reportAllChanges：每次数值变化都回调。插件因此总能拿到最新值，
  // 即使 destroy() 发生在页面隐藏之前（SPA 卸载、热更新），也能提交当时的值。
  onLCP(forward, { reportAllChanges: true });
  onCLS(forward, { reportAllChanges: true });
  onINP(forward, { reportAllChanges: true });
  onFCP(forward);
  onTTFB(forward);
}

function round(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.round(value * 10) / 10;
}

/**
 * 从归因里挑出排查要用的部分：造成指标的元素（统一放在 target），以及指标拆成的几段耗时。
 * 原始归因里还有 PerformanceEntry 对象（DOM 元素引用、完整的条目列表），体积大、大多用不上，不整体上报。
 * 元素是 web-vitals 生成的 CSS 选择器（标签、id、class），不含页面文字；地址由核心脱敏。
 */
function attributionOf(metric: MetricWithAttribution): Record<string, unknown> | undefined {
  // 旧浏览器或测试替身可能不带归因。
  if (!metric.attribution) return undefined;
  switch (metric.name) {
    case 'LCP': {
      const lcp = metric.attribution;
      return {
        target: lcp.target,
        url: lcp.url,
        timeToFirstByte: round(lcp.timeToFirstByte),
        resourceLoadDelay: round(lcp.resourceLoadDelay),
        resourceLoadDuration: round(lcp.resourceLoadDuration),
        elementRenderDelay: round(lcp.elementRenderDelay),
      };
    }
    case 'CLS': {
      const cls = metric.attribution;
      return {
        target: cls.largestShiftTarget,
        largestShiftTime: round(cls.largestShiftTime),
        largestShiftValue:
          cls.largestShiftValue === undefined
            ? undefined
            : Number(cls.largestShiftValue.toFixed(4)),
        loadState: cls.loadState,
      };
    }
    case 'INP': {
      const inp = metric.attribution;
      const script = inp.longestScript;
      return {
        target: inp.interactionTarget,
        interactionType: inp.interactionType,
        inputDelay: round(inp.inputDelay),
        processingDuration: round(inp.processingDuration),
        presentationDelay: round(inp.presentationDelay),
        loadState: inp.loadState,
        // 与这次交互重叠最久的脚本（来自长动画帧 LoAF）：慢在哪段代码、由什么触发。
        ...(script
          ? {
              longestScript: {
                sourceURL: script.entry.sourceURL,
                sourceFunctionName: script.entry.sourceFunctionName,
                invoker: script.entry.invoker,
                invokerType: script.entry.invokerType,
                subpart: script.subpart,
                duration: round(script.intersectingDuration),
              },
            }
          : {}),
      };
    }
    case 'FCP': {
      const fcp = metric.attribution;
      return {
        timeToFirstByte: round(fcp.timeToFirstByte),
        firstByteToFCP: round(fcp.firstByteToFCP),
        loadState: fcp.loadState,
      };
    }
    case 'TTFB': {
      const ttfb = metric.attribution;
      return {
        waitingDuration: round(ttfb.waitingDuration),
        cacheDuration: round(ttfb.cacheDuration),
        dnsDuration: round(ttfb.dnsDuration),
        connectionDuration: round(ttfb.connectionDuration),
        requestDuration: round(ttfb.requestDuration),
      };
    }
  }
}

// FCP 和 TTFB 一经产生就不再变化，到达即上报；另外三个在页面生命周期里持续变化，
// 只在页面隐藏（核心调用 onPageHidden）或插件销毁时提交最新值。
const FINAL_ON_ARRIVAL = new Set<MetricWithAttribution['name']>(['FCP', 'TTFB']);

export class PerformancePlugin implements MonitorPlugin {
  readonly name = 'PerformancePlugin';
  private context?: PluginContext;
  // 每个指标实例（metric.id）已经上报过的值。值变化后会以同一个 id 再报一次，服务端按 id 覆盖。
  private readonly reported = new Map<string, number>();
  private readonly pending = new Map<MetricWithAttribution['name'], Sample>();
  private readonly onSample = (sample: Sample) => {
    if (FINAL_ON_ARRIVAL.has(sample.metric.name)) this.report(sample);
    else this.pending.set(sample.metric.name, sample);
  };

  setup(context: PluginContext): void {
    if (this.context || typeof window === 'undefined') return;
    this.context = context;
    subscribers.add(this.onSample);
    registerOnce();
    // 晚于首批指标创建的实例（例如 StrictMode 下的第二次挂载）补收已有的值。
    // 放进微任务是因为 setup 期间核心会屏蔽采集；重复的值与之前同 id，服务端覆盖而不是重复计数。
    queueMicrotask(() => {
      if (!this.context) return;
      for (const sample of latest.values()) this.onSample(sample);
    });
  }

  private report({ metric, page }: Sample): void {
    if (this.reported.get(metric.id) === metric.value) return;
    const eventId = this.context?.captureEvent(
      'performance',
      {
        metric: metric.name,
        value: Number(metric.value.toFixed(metric.name === 'CLS' ? 4 : 1)),
        rating: metric.rating,
        metricId: metric.id,
        navigationType: metric.navigationType,
        attribution: attributionOf(metric),
      },
      { page },
    );
    // 只在真正进入采集链路后才记为已上报；被闸门或 beforeSend 拦下的值下次还有机会。
    if (eventId) this.reported.set(metric.id, metric.value);
  }

  /**
   * 页面进入后台或即将卸载：提交 LCP/CLS/INP 的最新值。由核心在传输层的退出发送之前调用；
   * 插件自己监听 pagehide 的话，监听器可能排在传输层之后，提交的值就赶不上这次发送。
   */
  onPageHidden(): void {
    for (const sample of this.pending.values()) this.report(sample);
    this.pending.clear();
  }

  teardown(): void {
    this.onPageHidden();
    subscribers.delete(this.onSample);
    this.reported.clear();
    this.context = undefined;
  }
}
