import type { MonitorPlugin, PluginContext } from '../types';

/** 用户能点击操作的元素。点击的文字说明只从这些元素上取。 */
const INTERACTIVE = [
  'button',
  'a[href]',
  'summary',
  'select',
  'label',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
].join(',');

/** 标记了这个属性的元素（及其内部）只记录标签和 id/class，不记录任何文字。 */
const MASK_ATTRIBUTE = 'data-tp-mask';
const MAX_LABEL_LENGTH = 80;

function identity(element: Element): string {
  const suffix = element.id
    ? `#${element.id}`
    : element.classList[0]
      ? `.${element.classList[0]}`
      : '';
  return `${element.tagName.toLowerCase()}${suffix}`;
}

/**
 * 逐个文本节点累加，凑够上限就停。不用 textContent：它要把整棵子树的文字拼成一个字符串，
 * 点在一个装着几千行数据的容器上时，每次点击都要在业务处理之前同步付出这个代价。
 */
function boundedText(element: Element): string {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '';
  for (
    let node = walker.nextNode();
    node !== null && text.length <= MAX_LABEL_LENGTH;
    node = walker.nextNode()
  ) {
    text += (node.nodeValue ?? '').replace(/\s+/g, ' ');
  }
  return text.trim();
}

function controlLabel(control: Element): string {
  const aria = control.getAttribute('aria-label');
  if (aria) return aria;
  if (control instanceof HTMLInputElement) {
    // 按钮类 input 的文字在 value 里；勾选框和单选框只记 name，不记用户选了什么。
    return control.type === 'checkbox' || control.type === 'radio' ? control.name : control.value;
  }
  // 下拉框的文字是当前选中的值，属于用户输入，只记 name。
  if (control instanceof HTMLSelectElement) return control.name;
  return boundedText(control);
}

/**
 * 点击的可读描述：标签名、id 或首个 class，加上被点控件的文字。
 * 文字只取自按钮、链接这类可交互元素——那是开发者写的操作名。点在列表、卡片这类容器上时，
 * 容器里往往是姓名、邮箱、地址等页面数据，只记录标签和 id/class，不记任何文字。
 */
export function elementLabel(target: EventTarget | null): string {
  if (!(target instanceof Element)) return 'unknown element';
  // 点在按钮里的图标（常见的 <svg>）上时，target 是图标本身，要向上找到按钮。
  const control = target.closest(INTERACTIVE);
  const element = control ?? target;
  const masked = element.closest(`[${MASK_ATTRIBUTE}]`) !== null;
  // 不可交互的元素上只采用开发者写的 aria-label。
  const raw = masked
    ? ''
    : control
      ? controlLabel(control)
      : (target.getAttribute('aria-label') ?? '');
  const label = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
  return `${identity(element)}${label ? ` “${label}”` : ''}`;
}

function currentRoute(): string {
  return `${location.pathname}${location.hash}`;
}

export class BehaviorPlugin implements MonitorPlugin {
  readonly name = 'BehaviorPlugin';
  private context?: PluginContext;
  private originalPushState?: typeof history.pushState;
  private originalReplaceState?: typeof history.replaceState;
  private wrappedPushState?: typeof history.pushState;
  private wrappedReplaceState?: typeof history.replaceState;
  private lastRoute?: string;
  private readonly clickListener = (event: MouseEvent) => {
    this.context?.addBreadcrumb({
      type: 'click',
      category: 'ui.click',
      message: elementLabel(event.target),
    });
  };
  private readonly popStateListener = () => this.recordNavigation('popstate');

  setup(context: PluginContext): void {
    if (this.context || typeof window === 'undefined') return;
    this.context = context;
    this.lastRoute = currentRoute();
    // 捕获阶段可以在业务 handler 阻止冒泡前记录点击。
    document.addEventListener('click', this.clickListener, true);
    window.addEventListener('popstate', this.popStateListener);
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    this.originalPushState = originalPushState;
    this.originalReplaceState = originalReplaceState;
    const recordNavigation = (mechanism: string) => this.recordNavigation(mechanism);
    // SPA 路由变化不会触发 popstate，所以需要包装 pushState/replaceState。
    this.wrappedPushState = function (this: History, ...args) {
      const result = originalPushState.apply(this, args);
      recordNavigation('pushState');
      return result;
    };
    this.wrappedReplaceState = function (this: History, ...args) {
      const result = originalReplaceState.apply(this, args);
      recordNavigation('replaceState');
      return result;
    };
    history.pushState = this.wrappedPushState;
    history.replaceState = this.wrappedReplaceState;
  }

  private recordNavigation(mechanism: string): void {
    // 只在路由（路径与 hash）真的变化时记录。同步搜索框、筛选条件的 replaceState 往往只改查询参数，
    // 每次都记会把 50 条的面包屑缓冲冲掉，真正有用的证据被挤出去。
    const route = currentRoute();
    if (route === this.lastRoute) return;
    this.lastRoute = route;
    // 地址的查询参数由核心在加入面包屑时统一脱敏。
    this.context?.addBreadcrumb({
      type: 'navigation',
      category: 'route',
      message: `${mechanism} → ${route}`,
      data: { url: location.href },
    });
  }

  teardown(): void {
    if (typeof document !== 'undefined')
      document.removeEventListener('click', this.clickListener, true);
    if (typeof window !== 'undefined')
      window.removeEventListener('popstate', this.popStateListener);
    // 与 NetworkPlugin 相同：只有全局引用仍是自己的包装时才还原，否则留在链上只做透传。
    if (typeof history !== 'undefined') {
      if (this.wrappedPushState && history.pushState === this.wrappedPushState) {
        history.pushState = this.originalPushState!;
      }
      if (this.wrappedReplaceState && history.replaceState === this.wrappedReplaceState) {
        history.replaceState = this.originalReplaceState!;
      }
    }
    this.context = undefined;
    this.wrappedPushState = undefined;
    this.wrappedReplaceState = undefined;
  }
}
