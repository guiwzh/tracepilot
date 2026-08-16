import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';
import { errorPayload } from '../core/helpers';

/** 捕获没有 catch 的 Promise rejection，并复用 errorPayload 兼容任意 reason 类型。 */
export class PromisePlugin implements MonitorPlugin {
  readonly name = 'PromisePlugin';
  private core?: MonitorCore;
  private readonly listener = (event: PromiseRejectionEvent) => {
    this.core?.captureEvent('error', {
      ...errorPayload(event.reason),
      mechanism: 'unhandledrejection',
      level: 'error',
    });
  };

  setup(core: MonitorCore): void {
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    window.addEventListener('unhandledrejection', this.listener);
  }

  teardown(): void {
    if (typeof window !== 'undefined')
      window.removeEventListener('unhandledrejection', this.listener);
    this.core = undefined;
  }
}
