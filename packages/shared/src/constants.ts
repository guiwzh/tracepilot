export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_FLUSH_INTERVAL = 5_000;
export const MAX_BREADCRUMBS = 50;
export const PROMPT_VERSION = 'diagnosis-evidence-v1';

export const WEB_VITAL_THRESHOLDS = {
  LCP: [2_500, 4_000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1_800, 3_000],
  TTFB: [800, 1_800],
} as const;
