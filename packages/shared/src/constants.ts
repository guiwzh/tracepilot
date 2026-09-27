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
/** 同一个错误在这个时间窗口（毫秒）内重复出现，只上报第一次。 */
export const DEFAULT_DEDUPE_WINDOW = 5_000;
// 传输队列的默认上限（条数）。错误事件的大小主要取决于携带的 breadcrumb，通常在 1～10 KB，
// 1000 条约为几 MB 的驻留内存，足以扛过一次短暂的服务端不可用，又不至于在错误风暴中拖垮宿主页面。
// 单条事件超过 32 KB 会被 SDK 裁剪（仍超限则丢弃），所以最坏情况也有上界（约 32 MB）。
// 队列满时丢弃新事件、保留最早的证据，并计入丢弃统计。
export const DEFAULT_MAX_QUEUE_SIZE = 1_000;
/** 每个事件最多携带的 breadcrumb（报错前的用户操作、请求、路由变化）条数。 */
export const MAX_BREADCRUMBS = 50;
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
