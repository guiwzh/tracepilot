import type { MonitorPlugin, PluginContext } from '../types';
import { errorPayload } from '../core/helpers';

/** 监听 window.error，专门采集 JavaScript 运行时异常；资源错误由 ResourcePlugin 处理。 */
export class ErrorPlugin implements MonitorPlugin {
  readonly name = 'ErrorPlugin';
  private context?: PluginContext;
  private readonly listener = (event: ErrorEvent) => {
    // 元素上的 error 事件（例如脚本自己派发的、会冒泡的 error）不是运行时异常，必须跳过，避免重复上报。
    // 资源加载失败由 ResourcePlugin 在捕获阶段处理。
    if (!this.context || event.target instanceof Element) return;
    // event.message 是浏览器拼好的展示文本，Chrome 会加上 "Uncaught " 前缀。优先用抛出的原始值：
    // 同一个错误经 captureException 上报时没有这个前缀，两者消息不一致就会得到不同的指纹，
    // 被拆成两个 Issue。跨域脚本错误（"Script error."）等场景没有 error 对象，才退回 message。
    const thrown: unknown = event.error;
    const described =
      thrown !== undefined && thrown !== null
        ? errorPayload(thrown)
        : { name: 'Error', message: event.message || 'Unhandled runtime error' };
    this.context.captureEvent('error', {
      ...described,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      level: 'error',
    });
  };

  setup(context: PluginContext): void {
    // 保存同一个函数引用，teardown 才能正确 removeEventListener。
    if (this.context || typeof window === 'undefined') return;
    this.context = context;
    window.addEventListener('error', this.listener);
  }

  teardown(): void {
    if (typeof window !== 'undefined') window.removeEventListener('error', this.listener);
    this.context = undefined;
  }
}
