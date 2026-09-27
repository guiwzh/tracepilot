import { redactSensitive } from '@trace-pilot/shared';
import type { CapturePayload } from '../types';

/**
 * SDK 端的默认脱敏，与服务端入库时用的是同一套规则（packages/shared/src/redaction.ts）：
 * URL 去掉查询参数和片段，token、password、authorization 等字段整体遮蔽。
 *
 * 服务端本来也会脱敏，但那时数据已经离开了浏览器：带着 ?token= 的地址会经过网络、网关和代理日志。
 * 在 SDK 里先做一遍，敏感值从一开始就不出页面。
 */

/** 以 :行:列 结尾的一行是栈帧（V8 的 "at fn (url:1:2)"，Firefox / Safari 的 "fn@url:1:2"）。 */
const FRAME_LOCATION = /:\d+:\d+\)?\s*$/;
/** 栈帧里夹在文件名和 :行:列 之间的查询参数或片段，例如 app.js?v=3:1:420 里的 ?v=3。 */
const FRAME_QUERY = /[?#][^\s()]*?(?=:\d+:\d+)/g;

/**
 * 脱敏一段堆栈。不能直接套用通用的文本规则：它会把 "app.js?v=3:1:420)" 从问号起整段删掉，
 * 行列号一起丢失，服务端就再也无法用 Source Map 还原这一帧。
 * 所以栈帧只删查询参数、保留行列号；其余行（第一行的错误消息等）按普通文本处理。
 */
export function redactStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) =>
      FRAME_LOCATION.test(line) ? line.replace(FRAME_QUERY, '') : redactSensitive(line),
    )
    .join('\n');
}

/** 形状像堆栈、要按栈帧规则处理的字段。componentStack 来自 React 的错误回调。 */
const STACK_KEYS = ['stack', 'componentStack'] as const;

export function redactPayload(payload: CapturePayload): CapturePayload {
  const rest: CapturePayload = { ...payload };
  for (const key of STACK_KEYS) delete rest[key];
  const result = redactSensitive(rest);
  for (const key of STACK_KEYS) {
    if (!(key in payload)) continue;
    const value = payload[key];
    result[key] = typeof value === 'string' ? redactStack(value) : redactSensitive(value);
  }
  return result;
}
