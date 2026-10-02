import { stripUrlQuery, TRACE_ID_PATTERN } from '@trace-pilot/shared';
import type { RequestTrace } from '../types';

/**
 * W3C Trace Context（https://www.w3.org/TR/trace-context/）：给发往自家后端的请求加上
 * traceparent: 00-<trace id>-<span id>-01，后端的 OpenTelemetry、SkyWalking 等接着这条链路往下记。
 * 前端事件带上同一个 trace id，工作台就能从前端的 Issue 跳到后端那次请求的链路；
 * 反过来，后端拿着日志里的 trace id 也能在工作台搜到前端的 Issue。
 *
 * - 一次页面浏览一个 trace，路由变了就换新的。单页应用里一直不换，一个 trace 会攒下几个小时的请求，
 *   链路系统很难展示；每个请求一个 trace，又看不出同一个页面里的请求是一起的。
 *   路由在用到时才比较，不必再包装一次 history；查询参数和页内锚点的变化不算换页面。
 * - 每个请求一个新的 span id：它是后端服务端 span 的 parent。SDK 不上报自己的 span，
 *   链路系统里这个 parent 会显示为缺失，trace 照常可看。
 * - 采样标志固定为 01（sampled）：按父 span 决定采样的后端会保留这些 trace，工作台给出的链接才打得开。
 *   量由会话采样率（sampleRate）和传播范围（tracePropagationTargets）控制。
 */

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZEROS = /^0+$/;

/**
 * 随机的 trace id / span id。只在浏览器里、真要给请求加头时才调用（见 TraceContext），
 * crypto.getRandomValues 在非安全上下文里也可用，不需要降级。全 0 在规范里是无效值，重新取。
 */
function randomHex(bytes: number): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return ALL_ZEROS.test(hex) ? randomHex(bytes) : hex;
}

/** 合法的 trace id：32 位小写十六进制，不全为 0。 */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

/** 解析请求上已有的 traceparent（应用自己或另一个链路 SDK 加的）；不是合法的 00 版本时返回 null。 */
export function parseTraceparent(value: string): { traceId: string; spanId: string } | null {
  const match = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!match || ALL_ZEROS.test(match[1]!) || ALL_ZEROS.test(match[2]!)) return null;
  return { traceId: match[1]!, spanId: match[2]! };
}

function matchesPattern(pattern: RegExp, value: string): boolean {
  // 带 g、y 标志的正则，test 会从上一次匹配的位置继续找，先归零。
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * 这个地址的请求要不要带 traceparent。
 *
 * 没有配置时只有同源请求：跨域请求带上自定义头会先发一次 CORS 预检，对方没在
 * Access-Control-Allow-Headers 里放行 traceparent，请求就直接失败；trace id 也不该发给第三方。
 * 配置之后以配置为准：
 * - 字符串是 URL 前缀，按页面地址解析：'https://api.example.com' 是这个源下的全部请求，'/api/' 是同源的 /api/ 下。
 *   不做子串匹配：子串匹配下 'api.example.com' 也会匹配 https://api.example.com.evil.net/。
 * - 正则测试完整的 URL；同源请求还测试路径，所以 /^\/api\// 这样的写法也有效。
 * 只有 http(s) 请求会带：data:、blob: 没有后端。
 */
export function shouldPropagate(
  url: string,
  targets: ReadonlyArray<string | RegExp> | undefined,
): boolean {
  if (typeof location === 'undefined' || targets?.length === 0) return false;
  let resolved: URL;
  try {
    resolved = new URL(url, typeof document === 'undefined' ? location.href : document.baseURI);
  } catch {
    return false;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return false;
  const sameOrigin = resolved.origin === location.origin;
  if (!targets) return sameOrigin;
  return targets.some((target) => {
    if (typeof target !== 'string') {
      return (
        matchesPattern(target, resolved.href) ||
        (sameOrigin && matchesPattern(target, resolved.pathname))
      );
    }
    try {
      // URL 会规范化：'https://api.example.com' 变成 'https://api.example.com/'，前缀比较不会误中别的域名。
      return resolved.href.startsWith(new URL(target, location.origin).href);
    } catch {
      return false;
    }
  });
}

/**
 * 当前页面浏览的 trace：MonitorCore 持有一个，经 PluginContext 交给 NetworkPlugin。
 * trace id 在第一个要加头的请求发出时才生成；在那之前，事件路径什么也不用算。
 */
export class TraceContext {
  private traceId = '';
  private page: string | undefined;
  /** 这个 trace 是否已经有请求带给了后端。 */
  private propagated = false;

  /** 当前页面浏览的 trace id；页面（去掉查询参数的地址，hash 路由算在内）变了就开始一个新的。 */
  private current(): string {
    const page = typeof location === 'undefined' ? undefined : stripUrlQuery(location.href);
    if (!this.traceId || page !== this.page) {
      this.traceId = randomHex(16);
      this.page = page;
      this.propagated = false;
    }
    return this.traceId;
  }

  /** 给一个要带 traceparent 的请求开一个 span。调用即表示这个 trace 带给了后端。 */
  startRequestSpan(): RequestTrace {
    const traceId = this.current();
    const spanId = randomHex(8);
    this.propagated = true;
    return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
  }

  /**
   * 事件带的 trace id：只有这次页面浏览里已经有请求把它带给了后端才有。
   * 否则工作台给出的链路链接会打开一个后端从没见过的 trace。
   */
  eventTraceId(): string | undefined {
    if (!this.propagated) return undefined;
    // 页面换了，current() 会开始新的 trace 并把 propagated 清掉。
    const traceId = this.current();
    return this.propagated ? traceId : undefined;
  }
}
