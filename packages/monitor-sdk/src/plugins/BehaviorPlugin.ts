import type { MonitorPlugin } from '../types';
import type { MonitorCore } from '../core/MonitorCore';

// 只提取有限的可读标识，不保存完整 DOM 或输入框值，降低隐私风险和事件体积。
function elementLabel(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return 'unknown element';
  const label = target.getAttribute('aria-label') || target.textContent?.trim().slice(0, 80);
  const identity = target.id
    ? `#${target.id}`
    : target.classList[0]
      ? `.${target.classList[0]}`
      : '';
  return `${target.tagName.toLowerCase()}${identity}${label ? ` “${label}”` : ''}`;
}

export class BehaviorPlugin implements MonitorPlugin {
  readonly name = 'BehaviorPlugin';
  private core?: MonitorCore;
  private originalPushState?: typeof history.pushState;
  private originalReplaceState?: typeof history.replaceState;
  private readonly clickListener = (event: MouseEvent) => {
    this.core?.addBreadcrumb({
      type: 'click',
      category: 'ui.click',
      message: elementLabel(event.target),
    });
  };
  private readonly popStateListener = () => this.recordNavigation('popstate');

  setup(core: MonitorCore): void {
    if (this.core || typeof window === 'undefined') return;
    this.core = core;
    // 捕获阶段可以在业务 handler 阻止冒泡前记录点击。
    document.addEventListener('click', this.clickListener, true);
    window.addEventListener('popstate', this.popStateListener);
    this.originalPushState = history.pushState;
    this.originalReplaceState = history.replaceState;
    const originalPushState = this.originalPushState;
    const originalReplaceState = this.originalReplaceState;
    const recordNavigation = this.recordNavigation.bind(this);
    // SPA 路由变化不会触发 popstate，所以需要包装 pushState/replaceState。
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      recordNavigation('pushState');
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      recordNavigation('replaceState');
      return result;
    };
  }

  private recordNavigation(mechanism: string): void {
    // URL 会在 Server 再次脱敏；这里只记录导航机制和当前地址。
    this.core?.addBreadcrumb({
      type: 'navigation',
      category: 'route',
      message: `${mechanism} → ${location.pathname}${location.hash}`,
      data: { url: location.href },
    });
  }

  teardown(): void {
    if (typeof document !== 'undefined')
      document.removeEventListener('click', this.clickListener, true);
    if (typeof window !== 'undefined')
      window.removeEventListener('popstate', this.popStateListener);
    if (typeof history !== 'undefined') {
      if (this.originalPushState) history.pushState = this.originalPushState;
      if (this.originalReplaceState) history.replaceState = this.originalReplaceState;
    }
    this.core = undefined;
  }
}
