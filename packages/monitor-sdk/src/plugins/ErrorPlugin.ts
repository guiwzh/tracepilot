import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

export class ErrorPlugin implements MonitorPlugin {
  readonly name = 'ErrorPlugin';
  private core?: MonitorCore;
  private readonly listener = (event: ErrorEvent) => {
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
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    window.addEventListener('error', this.listener);
  }

  teardown(): void {
    if (typeof window !== 'undefined') window.removeEventListener('error', this.listener);
    this.core = undefined;
  }
}
