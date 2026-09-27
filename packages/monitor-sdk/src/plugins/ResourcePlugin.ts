import type { MonitorPlugin, PluginContext } from '../types';

// 不同 DOM 元素把资源地址放在不同属性中，这里统一为一个 URL。
function resourceUrl(target: EventTarget | null): string | undefined {
  if (target instanceof HTMLImageElement || target instanceof HTMLScriptElement) return target.src;
  if (target instanceof HTMLLinkElement) return target.href;
  if (target instanceof HTMLMediaElement) return target.currentSrc || target.src;
  return undefined;
}

/**
 * 采集图片、脚本、样式表和媒体的加载失败。同一批资源（只有数字不同的地址）在几秒内接连失败时，
 * 由核心的短窗口去重只上报第一条，一整页坏掉的缩略图不会变成几十个事件。
 */
export class ResourcePlugin implements MonitorPlugin {
  readonly name = 'ResourcePlugin';
  private context?: PluginContext;
  private readonly listener = (event: Event) => {
    if (!this.context || event.target === window) return;
    const target = event.target as HTMLElement | null;
    const url = resourceUrl(event.target);
    if (!url) return;
    this.context.captureEvent('resource', {
      url,
      tagName: target?.tagName?.toLowerCase() ?? 'unknown',
      resourceType: target?.tagName?.toLowerCase() ?? 'unknown',
      message: `Failed to load ${url}`,
    });
  };

  setup(context: PluginContext): void {
    if (this.context || typeof window === 'undefined') return;
    this.context = context;
    // 资源 error 不冒泡，必须在捕获阶段（第三个参数 true）从 window 监听。
    window.addEventListener('error', this.listener, true);
  }

  teardown(): void {
    if (typeof window !== 'undefined') window.removeEventListener('error', this.listener, true);
    this.context = undefined;
  }
}
