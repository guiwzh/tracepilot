/**
 * 跨 SDK、Server 和 Dashboard 共享的业务常量。
 * 放在 shared 包中可以避免各端各写一套默认值，导致采集与展示口径不一致。
 */
export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_FLUSH_INTERVAL = 5_000;
// 传输队列的默认上限。按每个事件约 1-2 KB 估算，上限对应几 MB 量级的驻留内存，
// 足以扛过一次短暂的服务端不可用，又不至于在错误风暴中拖垮宿主页面。
export const DEFAULT_MAX_QUEUE_SIZE = 1_000;
export const MAX_BREADCRUMBS = 50;
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
