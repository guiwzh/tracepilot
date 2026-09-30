import { isSensitiveKey } from '@trace-pilot/shared';
import type { ConsoleLevel, MonitorPlugin, PluginContext } from '../types';

/**
 * 把控制台输出记成面包屑。业务代码和框架常把「处理掉了、但值得注意」的问题打到控制台
 * （接口封装里 console.error 一个失败响应、React 的开发期告警），它们是之后报错的重要上下文。
 * 只记面包屑、不单独成为事件；默认只记 warn 和 error，log 太多，会把 50 条的缓冲挤满。
 *
 * 做法是替换 console 上对应的方法：先记录，再调用原方法，控制台照常输出。
 * 记录过程中的任何异常都被吞掉，业务的 console 调用绝不能因为监控而失败。
 */
const DEFAULT_LEVELS: ConsoleLevel[] = ['warn', 'error'];
const MAX_MESSAGE = 500;
const PREVIEW_ITEMS = 5;

/**
 * 把一个参数转成简短的文字。对象只展开一层、最多 5 项，更深的写成 {…} / […]：
 * 对大对象调用 JSON.stringify 会在业务的 console 调用里同步付出序列化的代价。敏感键的值直接遮蔽。
 */
function preview(value: unknown, nested = false): string {
  if (typeof value === 'string') return nested ? JSON.stringify(value) : value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'function') return '[function]';
  if (value === null || typeof value !== 'object') return String(value);
  if (nested) return Array.isArray(value) ? '[…]' : '{…}';
  const more = (count: number) => (count > PREVIEW_ITEMS ? ', …' : '');
  if (Array.isArray(value)) {
    const items = value.slice(0, PREVIEW_ITEMS).map((item) => preview(item, true));
    return `[${items.join(', ')}${more(value.length)}]`;
  }
  const keys = Object.keys(value);
  const entries = keys.slice(0, PREVIEW_ITEMS).map((key) => {
    const item = isSensitiveKey(key)
      ? '[REDACTED]'
      : preview((value as Record<string, unknown>)[key], true);
    return `${key}: ${item}`;
  });
  return `{${entries.join(', ')}${more(keys.length)}}`;
}

export class ConsolePlugin implements MonitorPlugin {
  readonly name = 'ConsolePlugin';
  private context?: PluginContext;
  private readonly wrapped = new Map<
    ConsoleLevel,
    { original: (...args: unknown[]) => void; wrapper: (...args: unknown[]) => void }
  >();

  setup(context: PluginContext): void {
    if (this.context || typeof console === 'undefined') return;
    const levels = context.options.consoleBreadcrumbs ?? DEFAULT_LEVELS;
    if (levels === false) return;
    this.context = context;
    for (const level of new Set(levels)) {
      const original = console[level] as ((...args: unknown[]) => void) | undefined;
      if (typeof original !== 'function') continue;
      const wrapper = (...args: unknown[]) => {
        try {
          this.record(level, args);
        } catch {
          // 参数的 getter 抛错之类的情况：放弃这一条，不影响业务的 console 调用。
        }
        original.apply(console, args);
      };
      this.wrapped.set(level, { original, wrapper });
      console[level] = wrapper;
    }
  }

  private record(level: ConsoleLevel, args: unknown[]): void {
    // teardown 之后包装可能还留在调用链上，只做透传。
    this.context?.addBreadcrumb({
      type: 'console',
      category: `console.${level}`,
      message: args
        .map((arg) => preview(arg))
        .join(' ')
        .slice(0, MAX_MESSAGE),
      data: { level },
    });
  }

  teardown(): void {
    // 与其他包装全局 API 的插件相同：只有全局引用仍是自己的包装时才还原。
    for (const [level, { original, wrapper }] of this.wrapped) {
      if (console[level] === wrapper) console[level] = original;
    }
    this.wrapped.clear();
    this.context = undefined;
  }
}
