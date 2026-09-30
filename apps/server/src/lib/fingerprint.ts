import { createHash } from 'node:crypto';
import { stripUrlQuery, type MonitorEvent } from '@trace-pilot/shared';

/**
 * 错误指纹：决定「哪些错误算同一个 Issue」。
 *
 * 线上同一个 bug 每天可能触发上万次，每次的错误消息都略有不同（订单号、用户 ID、时间戳……）。
 * 把这些动态部分替换成占位符后再算哈希，同一根因的所有发生就得到同一个指纹，
 * 在 issues 表里聚合成一行（UNIQUE(project_id, fingerprint)）。归一化不足会把一个问题拆成很多个 Issue；
 * 过度归一化则会把不同问题合并到一起。
 */

/** 生成参与指纹计算的归一化文本：动态片段换成占位符，再统一小写。 */
export function normalizeMessage(input: string): string {
  return (
    input
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid')
      // 13 位毫秒时间戳（以 16～29 开头，覆盖 2020 年之后）。
      .replace(/\b(?:1[6-9]|2\d)\d{11}\b/g, ':timestamp')
      // 4 位及以上的数字视为业务 ID。压缩文件的列号（如 :1:18234）也会被替换，
      // 所以同一压缩文件里不同位置的错误要靠错误类型和消息区分。
      .replace(/\b\d{4,}\b/g, ':id')
      // 构建产物文件名里的内容哈希每次发版都会变，不替换的话同一个错误换个版本就成了新 Issue。
      // 十六进制哈希（webpack 等，app.a81e93bd.js）：
      .replace(/([.-])[a-f0-9]{8,}(?=\.(?:js|mjs|css)|\b)/gi, '$1:hash')
      // Vite / Rollup 的 8 位 base64 哈希（index-C8pSMNq9.js）。要求含数字或大写字母，
      // 避免把 app-checkout.js 这种普通单词当成哈希。
      .replace(
        /([.-])([\w-]{8})(?=\.(?:js|mjs|css)\b)/g,
        (match, separator: string, hash: string) =>
          /[\dA-Z]/.test(hash) ? `${separator}:hash` : match,
      )
      // URL 只保留到路径，查询参数（?token=…）既是动态部分也可能是敏感信息。
      .replace(/https?:\/\/[^\s)]+/g, (url) => stripUrlQuery(url))
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/**
 * 生成 Issue 列表里显示的标题：同样替换动态 ID，但保留大小写、用 {id} 这类易读的占位符，
 * 也不替换文件哈希（排查时需要看到具体文件）。
 */
export function normalizeDisplayTitle(input: string): string {
  return input
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/\b(?:1[6-9]|2\d)\d{11}\b/g, '{timestamp}')
    .replace(/\b\d{4,}\b/g, '{id}')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 栈帧：以「:行:列」结尾的一行。V8 的 "at fn (url:1:2)"、Firefox / Safari 的 "fn@url:1:2" 都是；
 * 与 SDK 去重签名取首帧用的是同一条规则（monitor-sdk 的 core/helpers.ts 里的 firstFrame）。
 */
const FRAME_LINE = /:\d+:\d+\)?$/;

/**
 * 取堆栈里的第一个栈帧。它最接近出错点，比完整堆栈更适合参与指纹：
 * 完整堆栈会随调用路径（从哪个页面、哪个按钮进来）变化，同一个 bug 会被拆开。
 * 曾经把「第一行带 URL 或路径的文本」当作栈帧：V8 堆栈的第一行是错误消息，消息里带 `/`（例如请求地址）时
 * 取到的是消息行，同一条消息、不同出错位置的错误被并成了一个 Issue。没有栈帧时退回第一行。
 */
export function topStackFrame(stack?: string): string {
  if (!stack) return 'no-stack';
  const lines = stack.split('\n').map((item) => item.trim());
  const frame = lines.find((item) => FRAME_LINE.test(item));
  return normalizeMessage(frame ?? lines[0] ?? 'no-stack');
}

/** 失败请求在 Issue 标题里显示的结果：业务错误是「code 业务码」，其余是状态码（网络错误为 0）。 */
export function requestOutcome(payload: Record<string, unknown>): string {
  const code = payload.businessCode;
  if (typeof code === 'string' || typeof code === 'number') return `code ${String(code)}`;
  return String(payload.status ?? 'failed');
}

/**
 * 参与指纹的「消息」。失败的请求没有错误消息，按「方法 + 地址 + 状态码」区分：同一个地址上的
 * GET 404、POST 503 和连不上服务器是不同的问题，与 Issue 标题（POST /api/cart → 503）口径一致。
 * 曾经只用地址，三者被并成一个 Issue：标题随最新一条变化，级别停留在第一条的 warning，
 * 503 故障藏在一个「警告」里。业务码另外参与，见 eventFingerprint。
 */
function fingerprintMessage(event: MonitorEvent): string {
  const payload = event.payload;
  if (event.eventType === 'network') {
    return `${String(payload.method ?? 'GET').toUpperCase()} ${String(payload.url ?? 'request')} ${String(payload.status ?? 'failed')}`;
  }
  return String(payload.message ?? payload.url ?? payload.metric ?? 'unknown');
}

/** 事件的指纹 = SHA-256(错误类型 | 消息 | 栈顶帧)，三部分都先归一化。 */
export function eventFingerprint(event: MonitorEvent): string {
  const payload = event.payload;
  const kind = String(payload.name ?? payload.errorType ?? event.eventType);
  const message = fingerprintMessage(event);
  const stack = typeof payload.stack === 'string' ? payload.stack : undefined;
  // 业务码按原样参与，不经过归一化：它们常是 4～6 位数字，会被当成业务 ID 换成占位符，
  // 同一个接口上的「优惠券过期」和「库存变化」就被并成了一个 Issue。没有业务码的事件指纹不变。
  const businessCode =
    event.eventType === 'network' && payload.businessCode !== undefined
      ? `|code:${String(payload.businessCode)}`
      : '';
  // 存哈希而不是拼接后的原文：长度固定（64 个十六进制字符），适合作为唯一键和索引。
  return createHash('sha256')
    .update(
      `${normalizeMessage(kind)}|${normalizeMessage(message)}|${topStackFrame(stack)}${businessCode}`,
    )
    .digest('hex');
}
