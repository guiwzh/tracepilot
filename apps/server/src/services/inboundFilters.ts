import type { FilterReason, MonitorEvent, ProjectSettings } from '@trace-pilot/shared';

/**
 * 入站过滤：在限流和入库之前丢掉不该进入 Issue 列表的上报。SDK 自己也会过滤一部分（扩展里的报错、
 * Script error.），服务端再做一遍：旧版本的 SDK、别人写的上报代码、伪造的请求都不经过 SDK 的过滤；
 * 而且这里的规则改了立即对所有已经部署的页面生效，不必等业务方发版。
 *
 * 被过滤的事件不入库、不占限流额度，只按原因计数（services/outcomes.ts），在项目设置页看得到。
 * 规则与 Sentry 的 Inbound Filters 相同：浏览器扩展、爬虫、localhost、错误消息、版本。
 */

/** 浏览器扩展的脚本地址。 */
const EXTENSION_URL = /^(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;
/** 栈帧里的文件地址：任意协议的 URL，后面跟 :行:列。 */
const FRAME_URL = /([a-z][\w+.-]*:\/\/[^\s()]+?):\d+:\d+/i;
/** 以 :行:列 结尾的一行是栈帧（与 SDK、指纹用的是同一条规则）。 */
const FRAME_LINE = /:\d+:\d+\)?\s*$/;

/**
 * 搜索引擎、社交平台预览、监控探针、AI 爬虫的 User-Agent。取自 Sentry 的列表，补了几个新的 AI 爬虫。
 * 不含 HeadlessChrome：自动化测试（包括本仓库的 E2E）用它，它的报错是真实的。
 */
const WEB_CRAWLER =
  /Mediapartners-Google|AdsBot-Google|Googlebot|FeedFetcher-Google|Storebot-Google|APIs-Google|BingBot|BingPreview|Baiduspider|YandexBot|Sogou|Slurp|DuckDuckBot|Applebot|facebookexternalhit|ia_archiver|Bytespider|PetalBot|AhrefsBot|SemrushBot|GPTBot|ClaudeBot|PerplexityBot|bots?[/\s);]|spider[/\s);]|Slack|pingdom|lyticsbot|AWS Security Scanner|HubSpot Crawler|Better Uptime|Cloudflare-Healthchecks|Cloudflare-Diagnostics|GTmetrix|BrightEdgeOnCrawl|ELB-HealthChecker/i;

/** 通配符 * 转成正则，其余字符按字面匹配。 */
function globToRegExp(pattern: string, flags: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, flags);
}

function fromBrowserExtension(event: MonitorEvent): boolean {
  if (event.eventType !== 'error') return false;
  const { filename, stack } = event.payload;
  if (typeof filename === 'string' && EXTENSION_URL.test(filename)) return true;
  if (typeof stack !== 'string') return false;
  // 只看栈顶帧：扩展调用了应用的代码、在应用里出错时，栈顶是应用自己的帧，这种错误要留下。
  const top = stack.split('\n').find((line) => FRAME_LINE.test(line));
  const url = top ? FRAME_URL.exec(top)?.[1] : undefined;
  return url !== undefined && EXTENSION_URL.test(url);
}

function fromLocalhost(event: MonitorEvent): boolean {
  try {
    const host = new URL(event.page.url).hostname;
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

/** 错误消息规则匹配的文字：「类型: 消息」和消息本身，与工作台展示的一致。 */
function messagesOf(event: MonitorEvent): string[] {
  const { name, message } = event.payload;
  if (typeof message !== 'string') return [];
  return typeof name === 'string' ? [`${name}: ${message}`, message] : [message];
}

export type InboundFilter = (event: MonitorEvent) => FilterReason | null;

/** 编译好的过滤函数按设置内容缓存：每个信封都要用，规则里的通配符不必每次重新编译。 */
const compiled = new Map<string, InboundFilter>();

/** 由项目设置得到过滤函数：返回丢弃的原因，留下时返回 null。 */
export function inboundFilter(filters: ProjectSettings['inboundFilters']): InboundFilter {
  const key = JSON.stringify(filters);
  const cached = compiled.get(key);
  if (cached) return cached;
  const messagePatterns = filters.errorMessages.map((pattern) => globToRegExp(pattern, 'i'));
  const releasePatterns = filters.releases.map((pattern) => globToRegExp(pattern, ''));
  const filter: InboundFilter = (event) => {
    if (releasePatterns.some((pattern) => pattern.test(event.release))) return 'release';
    if (filters.localhost && fromLocalhost(event)) return 'localhost';
    if (filters.webCrawlers && WEB_CRAWLER.test(event.device.userAgent)) return 'web-crawler';
    if (filters.browserExtensions && fromBrowserExtension(event)) return 'browser-extension';
    if (
      messagePatterns.length > 0 &&
      messagesOf(event).some((text) => messagePatterns.some((pattern) => pattern.test(text)))
    ) {
      return 'error-message';
    }
    return null;
  };
  // 设置很少变：缓存只是避免重复编译，超过上限就整个清掉重来。
  if (compiled.size >= 100) compiled.clear();
  compiled.set(key, filter);
  return filter;
}
