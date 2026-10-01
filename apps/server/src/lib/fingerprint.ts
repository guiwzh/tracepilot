import { createHash } from 'node:crypto';
import { DEFAULT_FINGERPRINT, stripUrlQuery, type MonitorEvent } from '@trace-pilot/shared';

/**
 * 错误指纹：决定「哪些错误算同一个 Issue」。
 *
 * 线上同一个 bug 每天可能触发上万次，每次的错误消息都略有不同（订单号、用户 ID、时间戳……）。
 * 把这些动态部分替换成占位符后再算哈希，同一根因的所有发生就得到同一个指纹，
 * 经 issue_fingerprints 表指向同一个 Issue。归一化不足会把一个问题拆成很多个 Issue；
 * 过度归一化则会把不同问题合并到一起。
 *
 * 现行算法（v2）在 Source Map 还原之后计算，用应用自己的栈顶帧在源码里的位置：
 * 「源文件 + 函数名 + 出错那行代码」，不看行列号。压缩后的函数名和列号每次构建都可能变，
 * 按它们聚合的话，同一个 bug 发一次版就成了新 Issue，回归检测也随之失效；
 * 出错那行代码则不随上下文的增删而变。没有 map 时退回压缩后的栈顶帧（与 v1 相同）。
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
 * 503 故障藏在一个「警告」里。业务码另外参与，见 businessCodePart。
 */
function fingerprintMessage(event: MonitorEvent): string {
  const payload = event.payload;
  if (event.eventType === 'network') {
    return `${String(payload.method ?? 'GET').toUpperCase()} ${String(payload.url ?? 'request')} ${String(payload.status ?? 'failed')}`;
  }
  return String(payload.message ?? payload.url ?? payload.metric ?? 'unknown');
}

/** 业务码按原样参与，不经过归一化：它们常是 4～6 位数字，会被当成业务 ID 换成占位符，
 * 同一个接口上的「优惠券过期」和「库存变化」就被并成了一个 Issue。没有业务码的事件指纹不变。 */
function businessCodePart(event: MonitorEvent): string {
  return event.eventType === 'network' && event.payload.businessCode !== undefined
    ? `|code:${String(event.payload.businessCode)}`
    : '';
}

function errorKind(event: MonitorEvent): string {
  return String(event.payload.name ?? event.payload.errorType ?? event.eventType);
}

// 存哈希而不是拼接后的原文：长度固定（64 个十六进制字符），适合作为唯一键和索引。
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * v1 指纹 = SHA-256(错误类型 | 消息 | 压缩后的栈顶帧)，三部分都先归一化。
 * 现在只用来找到升级到 v2 之前建的 Issue：它们在 issue_fingerprints 里只登记了 v1 指纹。
 */
export function legacyFingerprint(event: MonitorEvent): string {
  const stack = typeof event.payload.stack === 'string' ? event.payload.stack : undefined;
  return sha256(
    `${normalizeMessage(errorKind(event))}|${normalizeMessage(fingerprintMessage(event))}|${topStackFrame(stack)}${businessCodePart(event)}`,
  );
}

/** 聚合只需要的栈帧信息；services/sourcemaps.ts 的 ResolvedFrame 满足它。 */
export interface GroupingFrame {
  raw: string;
  file: string;
  original?: { source: string; line: number; name: string | null; contextLine: string | null };
}

/**
 * 不属于应用自己代码的帧：依赖包（node_modules，包括 Vite 开发时的 /node_modules/.vite/deps/）、
 * 浏览器扩展、打包器的运行时。崩在 React 内部的错误，栈顶是 react-dom 的帧，按它聚合会把
 * 所有「渲染时出错」并成一个 Issue；应该往下找第一个应用自己的帧。
 */
const NOT_IN_APP =
  /(?:^|\/)node_modules\/|(?:chrome|moz|safari|safari-web)-extension:\/\/|^webpack\/(?:runtime|bootstrap)|^\(webpack\)/i;

export function isInAppFrame(frame: GroupingFrame): boolean {
  return !NOT_IN_APP.test(frame.original?.source ?? frame.file) && !NOT_IN_APP.test(frame.raw);
}

/** 源文件路径去掉打包器加的前缀（webpack://app/、./、../），同一个文件在不同构建里写法一致。 */
function sourcePath(source: string): string {
  return source
    .replace(/^webpack:\/\/[^/]*\//i, '')
    .replace(/^(?:\.\.?\/)+/, '')
    .replace(/[?#].*$/, '');
}

/**
 * 参与聚合的那一帧：第一个应用自己的帧，没有就用栈顶帧。
 * 映射到源码时取「源文件 + 函数名 + 出错那行代码」；map 没有内联源码时用行号代替代码。
 * 映射不到时用压缩后的这一行（与 v1 的栈顶帧相同的归一化）。
 */
export function groupingFrame(frames: readonly GroupingFrame[]): string | null {
  const frame = frames.find(isInAppFrame) ?? frames[0];
  if (!frame) return null;
  const original = frame.original;
  if (!original) return normalizeMessage(frame.raw);
  const code = original.contextLine?.replace(/\s+/g, ' ');
  return normalizeMessage(
    `${sourcePath(original.source)}:${original.name ?? ''}:${code ?? `line ${original.line}`}`,
  );
}

/**
 * 默认指纹（v2）= SHA-256(v2 | 错误类型 | 消息 | 聚合帧 [| 业务码])。frames 是还原之后的栈帧；
 * 不传或为空（没有堆栈、解析不出栈帧）时，退回从堆栈文本里取栈顶帧。
 */
export function defaultFingerprint(
  event: MonitorEvent,
  frames: readonly GroupingFrame[] = [],
): string {
  const stack = typeof event.payload.stack === 'string' ? event.payload.stack : undefined;
  const frame = groupingFrame(frames) ?? topStackFrame(stack);
  return sha256(
    `v2|${normalizeMessage(errorKind(event))}|${normalizeMessage(fingerprintMessage(event))}|${frame}${businessCodePart(event)}`,
  );
}

/**
 * 事件归入 Issue 用的指纹。SDK 传了自定义指纹（event.fingerprint）时按它算，
 * 其中的 "{{ default }}" 换成默认指纹：['{{ default }}', 'tenant-a'] 表示在默认结果上再按租户细分。
 */
export function issueFingerprint(
  event: MonitorEvent,
  frames: readonly GroupingFrame[] = [],
): { fingerprint: string; algorithm: 'v2' | 'custom' } {
  const base = defaultFingerprint(event, frames);
  if (!event.fingerprint?.length) return { fingerprint: base, algorithm: 'v2' };
  const parts = event.fingerprint.map((part) => (part === DEFAULT_FINGERPRINT ? base : part));
  // \u0000 不会出现在 SDK 校验过的字符串里，用它分隔，['a|b'] 和 ['a', 'b'] 不会撞成同一个指纹。
  return { fingerprint: sha256(`custom|${parts.join('\u0000')}`), algorithm: 'custom' };
}
