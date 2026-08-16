import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

/** 监听 window.error，专门采集 JavaScript 运行时异常；资源错误由 ResourcePlugin 处理。 */
export class ErrorPlugin implements MonitorPlugin {
  readonly name = 'ErrorPlugin';
  private core?: MonitorCore;
  private readonly listener = (event: ErrorEvent) => {
    // error 事件也会从 img/script 等元素冒泡；target 不是 window 时必须跳过，避免重复上报。
    if (!this.core || event.target !== window) return;
    this.core.captureEvent('error', {
      name: event.error?.name ?? 'Error',
      message: event.message || event.error?.message || 'Unhandled runtime error',
      stack: event.error?.stack,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      level: 'error',
    });
  };

  setup(core: MonitorCore): void {
    // 保存同一个函数引用，teardown 才能正确 removeEventListener。
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    window.addEventListener('error', this.listener);
  }

  teardown(): void {
    if (typeof window !== 'undefined') window.removeEventListener('error', this.listener);
    this.core = undefined;
  }
}
