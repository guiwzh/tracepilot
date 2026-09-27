import type { MonitorPlugin, PluginContext } from '../types';
import { errorPayload } from '../core/helpers';

/** 捕获没有 catch 的 Promise rejection，并复用 errorPayload 兼容任意 reason 类型。 */
export class PromisePlugin implements MonitorPlugin {
  readonly name = 'PromisePlugin';
  private context?: PluginContext;
  private readonly listener = (event: PromiseRejectionEvent) => {
    this.context?.captureEvent('error', {
      ...errorPayload(event.reason),
      mechanism: 'unhandledrejection',
      level: 'error',
    });
  };

  setup(context: PluginContext): void {
    if (this.context || typeof window === 'undefined') return;
    this.context = context;
    window.addEventListener('unhandledrejection', this.listener);
  }

  teardown(): void {
    if (typeof window !== 'undefined')
      window.removeEventListener('unhandledrejection', this.listener);
    this.context = undefined;
  }
}
