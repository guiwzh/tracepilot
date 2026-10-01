/**
 * 跨 SDK、Server 和 Dashboard 共享的业务常量。
 * 放在 shared 包中可以避免各端各写一套默认值，导致采集与展示口径不一致。
 */
/** SDK 攒够多少条事件就立即发送一批。 */
export const DEFAULT_BATCH_SIZE = 10;
/** 没攒够一批时，最多等多久（毫秒）也发送。 */
export const DEFAULT_FLUSH_INTERVAL = 5_000;
/** 一批发送失败后，在同一轮里最多再快速重试几次（间隔 100 ms、200 ms……）。 */
export const DEFAULT_MAX_RETRIES = 2;
/** 同一个错误、资源或失败请求在这个时间窗口（毫秒）内重复出现，只上报第一次；窗口从上一次上报算起。 */
export const DEFAULT_DEDUPE_WINDOW = 5_000;
// 传输队列的默认上限（条数）。错误事件的大小主要取决于携带的 breadcrumb，通常在 1～10 KB，
// 1000 条约为几 MB 的驻留内存，足以扛过一次短暂的服务端不可用，又不至于在错误风暴中拖垮宿主页面。
// 单条事件超过 32 KB 会被 SDK 裁剪（仍超限则丢弃），所以最坏情况也有上界（约 32 MB）。
// 队列满时丢弃新事件、保留最早的证据，并计入丢弃统计。
export const DEFAULT_MAX_QUEUE_SIZE = 1_000;
/** 每个事件最多携带的 breadcrumb（报错前的用户操作、请求、路由变化）条数。 */
export const MAX_BREADCRUMBS = 50;
/** 自定义指纹里代表「默认指纹」的占位符，见 MonitorEvent.fingerprint。 */
export const DEFAULT_FINGERPRINT = '{{ default }}';
/**
 * 构建插件注入到每个产物文件开头的登记表在全局对象上的属性名：键是该文件顶层 new Error().stack，
 * 值是这个文件的 Debug ID。SDK 从堆栈里解析出文件地址，把事件涉及的文件和 Debug ID 一起上报。
 */
export const DEBUG_ID_REGISTRY = '__TRACEPILOT_DEBUG_IDS__';
/** Debug ID 的格式：小写 UUID，与 ECMA-426 提案和 Sentry 的约定一致。 */
export const DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 单次诊断的提示词版本，参与诊断缓存键；改动提示词时要递增，旧缓存才会失效。 */
export const PROMPT_VERSION = 'diagnosis-evidence-v1';

// Web Vitals 官方分级的两个边界值：[良好上限, 较差起点]。
// CLS 是无单位分数，其余指标的单位都是毫秒。
export const WEB_VITAL_THRESHOLDS = {
  LCP: [2_500, 4_000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1_800, 3_000],
  TTFB: [800, 1_800],
} as const;
