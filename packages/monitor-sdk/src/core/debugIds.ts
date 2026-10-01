import { DEBUG_ID_REGISTRY, type MonitorEvent } from '@trace-pilot/shared';

/**
 * 读取构建插件（@trace-pilot/vite-plugin）注入的 Debug ID 登记表，找出堆栈里各个产物文件的 Debug ID。
 *
 * 插件在每个产物文件开头注入一小段代码：在文件顶层 new Error()，以它的 stack 为键、
 * 这个文件的 Debug ID 为值，写进全局的登记表。stack 的第一帧就是这个文件自己的地址。
 * 为什么不直接登记地址：ES 模块里 document.currentScript 是 null，import.meta.url 又只有 ES 模块才有，
 * 而 new Error().stack 在任何格式的产物里都带着文件地址；Sentry 的插件也是这样做的。
 * 页面加载时只多一次 new Error()，解析堆栈留到真的出错时才做。
 */

/** 栈帧里的文件地址（V8 的「at fn (url:1:2)」、Firefox / Safari 的「fn@url:1:2」）。 */
const FRAME_FILE = /((?:https?|file):\/\/[^\s()@]+|\/[^\s()@]+):\d+:\d+/;
/** 一个事件最多带多少个文件的 Debug ID，与服务端的校验上限一致。 */
const MAX_DEBUG_IDS = 50;

/** 登记表里每个键（一段 stack）解析出的文件地址；同一个键只解析一次。 */
const fileOfEntry = new Map<string, string | null>();

/** 去掉查询参数和片段：事件的堆栈在 SDK 和服务端都会被脱敏删掉它们，按同样的形式比较。 */
function assetUrl(file: string): string {
  return file.replace(/[?#].*$/, '');
}

function frameFile(line: string): string | null {
  const file = FRAME_FILE.exec(line)?.[1];
  return file ? assetUrl(file) : null;
}

/** 登记表当前的「文件地址 → Debug ID」。懒加载的 chunk 随时会往登记表里追加，所以每次都重新对一遍。 */
function debugIdsByFile(): Map<string, string> {
  const byFile = new Map<string, string>();
  const registry = (globalThis as Record<string, unknown>)[DEBUG_ID_REGISTRY];
  if (!registry || typeof registry !== 'object') return byFile;
  for (const [stack, debugId] of Object.entries(registry as Record<string, unknown>)) {
    if (typeof debugId !== 'string') continue;
    let file = fileOfEntry.get(stack);
    if (file === undefined) {
      file = stack.split('\n').map(frameFile).find(Boolean) ?? null;
      fileOfEntry.set(stack, file);
    }
    if (file) byFile.set(file, debugId);
  }
  return byFile;
}

/** 堆栈里出现的、登记过 Debug ID 的文件，按出现顺序；一个都没有时返回 undefined，事件不带这个字段。 */
export function debugIdsFor(stack: unknown): MonitorEvent['debugIds'] {
  if (typeof stack !== 'string') return undefined;
  const byFile = debugIdsByFile();
  if (byFile.size === 0) return undefined;
  const result: NonNullable<MonitorEvent['debugIds']> = [];
  const seen = new Set<string>();
  for (const line of stack.split('\n')) {
    const file = frameFile(line);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const debugId = byFile.get(file);
    if (debugId) result.push({ file, debugId });
    if (result.length === MAX_DEBUG_IDS) break;
  }
  return result.length > 0 ? result : undefined;
}
