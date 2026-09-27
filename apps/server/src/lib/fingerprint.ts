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
 * 取堆栈里第一个带文件位置的帧。它最接近出错点，比完整堆栈更适合参与指纹：
 * 完整堆栈会随调用路径（从哪个页面、哪个按钮进来）变化，同一个 bug 会被拆开。
 */
export function topStackFrame(stack?: string): string {
  if (!stack) return 'no-stack';
  const line = stack
    .split('\n')
    .map((item) => item.trim())
    .find((item) => /(?:https?:\/\/|\/|\w+\.js):?\d*/.test(item));
  return normalizeMessage(line ?? stack.split('\n')[0] ?? 'no-stack');
}

/** 事件的指纹 = SHA-256(错误类型 | 消息 | 栈顶帧)，三部分都先归一化。 */
export function eventFingerprint(event: MonitorEvent): string {
  const payload = event.payload;
  const kind = String(payload.name ?? payload.errorType ?? event.eventType);
  const message = String(payload.message ?? payload.url ?? payload.metric ?? 'unknown');
  const stack = typeof payload.stack === 'string' ? payload.stack : undefined;
  // 存哈希而不是拼接后的原文：长度固定（64 个十六进制字符），适合作为唯一键和索引。
  return createHash('sha256')
    .update(`${normalizeMessage(kind)}|${normalizeMessage(message)}|${topStackFrame(stack)}`)
    .digest('hex');
}
