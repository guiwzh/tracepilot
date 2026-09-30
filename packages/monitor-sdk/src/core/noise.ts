import type { MonitorEvent } from '@trace-pilot/shared';
import type { CapturePayload } from '../types';
import { firstFrame } from './helpers';

/**
 * 噪声过滤与短窗口去重的规则。被过滤的信号不会形成事件，也就不会变成 Issue、
 * 不会进入排障 Agent 的证据——噪声的代价远不止多存几行数据。
 */

/** 默认忽略的错误消息，无论接入方配置什么都生效。 */
const IGNORED_MESSAGES: RegExp[] = [
  // 跨域脚本没带 crossorigin 时，浏览器只给出这一句：没有消息、堆栈和位置，无法诊断，也无法彼此区分。
  /^Script error\.?$/,
  // 一帧里没处理完的 ResizeObserver 通知会被推迟到下一帧，规范行为，不影响页面功能。
  /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/,
];

/** 浏览器扩展注入页面的脚本，报错与业务代码无关。 */
const EXTENSION_URL = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//;

export function isIgnoredError(
  payload: CapturePayload,
  extra: ReadonlyArray<string | RegExp> = [],
): boolean {
  const message = String(payload.message ?? '');
  if (IGNORED_MESSAGES.some((pattern) => pattern.test(message))) return true;
  if (
    extra.some((rule) => (typeof rule === 'string' ? message.includes(rule) : rule.test(message)))
  ) {
    return true;
  }
  // 以出错文件判断；没有文件信息（Promise rejection、手动上报）时看栈顶帧。
  const origin =
    typeof payload.filename === 'string' ? payload.filename : firstFrame(payload.stack);
  return EXTENSION_URL.test(origin);
}

/**
 * 去掉查询和片段，把数字串归一：/thumbs/product-17.png 与 /thumbs/product-18.png、
 * /api/orders/1001 与 /api/orders/1002 在去重时视为同一处。
 * 同一个接口或同一批资源在几秒内接连失败，第一条就足以作为证据，其余只会挤占队列。
 */
function urlPattern(value: unknown): string {
  return String(value ?? '')
    .replace(/[?#].*$/, '')
    .replace(/\d+/g, '0');
}

/** 去重签名；返回 null 表示这类事件不参与去重。 */
export function dedupeSignature(
  eventType: MonitorEvent['eventType'],
  payload: CapturePayload,
): string | null {
  switch (eventType) {
    case 'error':
      // 行列号常随构建变化；签名只保留错误类型、消息和归一化后的首个调用帧。
      return `error|${String(payload.name ?? '')}|${String(payload.message ?? '')}|${firstFrame(payload.stack)}`;
    case 'resource':
      return `resource|${String(payload.tagName ?? '')}|${urlPattern(payload.url)}`;
    case 'network':
      // 业务码也参与：同一个接口返回不同的业务错误（余额不足、优惠券过期）是不同的证据。
      return `network|${String(payload.method ?? '')}|${urlPattern(payload.url)}|${String(payload.status ?? '')}|${String(payload.businessCode ?? '')}`;
    default:
      // 指标样本由服务端按 metricId 覆盖，同一指标的新值必须送达，不能在这里挡掉。
      return null;
  }
}
