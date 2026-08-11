import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

function resourceUrl(target: EventTarget | null): string | undefined {
  if (target instanceof HTMLImageElement || target instanceof HTMLScriptElement) return target.src;
  if (target instanceof HTMLLinkElement) return target.href;
  if (target instanceof HTMLMediaElement) return target.currentSrc || target.src;
  return undefined;
}

export class ResourcePlugin implements MonitorPlugin {
  readonly name = 'ResourcePlugin';
  private core?: MonitorCore;
  private readonly listener = (event: Event) => {
    if (!this.core || event.target === window) return;
    const target = event.target as HTMLElement | null;
    const url = resourceUrl(event.target);
    if (!url) return;
    this.core.captureEvent('resource', {
      url,
      tagName: target?.tagName?.toLowerCase() ?? 'unknown',
      resourceType: target?.tagName?.toLowerCase() ?? 'unknown',
      message: `Failed to load ${url}`,
    });
  };

  setup(core: MonitorCore): void {
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    window.addEventListener('error', this.listener, true);
  }

  teardown(): void {
    if (typeof window !== 'undefined') window.removeEventListener('error', this.listener, true);
    this.core = undefined;
  }
}
