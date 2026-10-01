import { createHash } from 'node:crypto';
import { DEBUG_ID_REGISTRY } from '@trace-pilot/shared';

/**
 * Debug ID 的生成与注入，与打包工具无关的纯函数部分。
 *
 * Debug ID 把一个产物文件和它的 Source Map 一一绑定：两者写入同一个 UUID，服务端按它找 map，
 * 不再依赖「版本号 + 文件名」对得上。做法与 ECMA-426（Source Map 规范）的 Debug ID 提案一致：
 * map 里加 debugId 字段，产物末尾加一行 //# debugId=…。浏览器还没有在运行时读取它的接口，
 * 所以另外在产物开头注入一小段代码，把它登记到全局（与 Sentry 的做法相同），SDK 从那里读取。
 */

/**
 * 由产物内容算出 Debug ID：内容的 SHA-256 取前 128 位，按 UUID v4 的格式写版本号和变体位。
 * 同样的内容永远得到同样的 ID：重新构建出相同的文件，重新上传的是同一份 map（服务端替换而不是新增）；
 * 内容变了，ID 一定跟着变。
 */
export function debugIdFor(code: string): string {
  const hex = createHash('sha256').update(code).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * 注入到产物开头的登记代码。在文件顶层 new Error()，它的 stack 第一帧就是这个文件自己的地址，
 * 以它为键登记 Debug ID。不直接写地址：构建时不知道文件最终部署在哪个域名、哪个路径下。
 * 整段包在 try 里，任何异常都不能影响业务代码执行。
 */
export function registrySnippet(debugId: string): string {
  return (
    `;!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},` +
    `s=(new Error).stack;s&&((g.${DEBUG_ID_REGISTRY}=g.${DEBUG_ID_REGISTRY}||{})[s]="${debugId}")}catch(e){}}();`
  );
}

/** Source Map 里本插件要读写的字段。 */
export interface RawMap {
  mappings: string;
  debugId?: string;
  [key: string]: unknown;
}

/**
 * 把 Debug ID 写进一个产物文件和它的 map，返回新的代码和 map。
 *
 * 登记代码单独占一行插进去，map 只需在对应位置插入一个空的行：mappings 用分号分隔产物的每一行，
 * 多一个分号，后面所有行的映射整体下移一行，行内的列号不受影响。插在已有的一行里则要改那一行
 * 每一段的列偏移；插到第一行的开头而不换行，压缩成一行的产物里每一个位置都要改。
 *
 * 一般插在最前面。开头是 #!（Node 脚本）或独占一行的 'use strict'（CJS / IIFE 产物）时插在它后面：
 * #! 必须是文件的第一行，'use strict' 只有作为第一条语句才生效。
 */
export function injectDebugId(
  code: string,
  map: RawMap,
  debugId: string,
): { code: string; map: RawMap } {
  const lines = code.split('\n');
  let at = 0;
  if (lines[0]?.startsWith('#!')) at = 1;
  if (/^\s*(['"])use strict\1;?\s*$/.test(lines[at] ?? '')) at += 1;
  lines.splice(at, 0, registrySnippet(debugId));
  const mappings = map.mappings.split(';');
  // mappings 的行数可能少于代码行数（末尾没有映射的行可以省略），补齐之后再插入。
  while (mappings.length < at) mappings.push('');
  mappings.splice(at, 0, '');
  const body = lines.join('\n');
  return {
    code: `${body}${body.endsWith('\n') ? '' : '\n'}//# debugId=${debugId}\n`,
    map: { ...map, mappings: mappings.join(';'), debugId },
  };
}
