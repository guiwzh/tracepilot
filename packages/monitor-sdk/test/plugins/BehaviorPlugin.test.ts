import { afterEach, describe, expect, it } from 'vitest';
import type { BreadcrumbInput, PluginContext, ResolvedMonitorOptions } from '../../src/types';
import { BehaviorPlugin, elementLabel } from '../../src/plugins/BehaviorPlugin';
import { TraceContext } from '../../src/core/trace';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

let plugin: BehaviorPlugin | undefined;

function install() {
  const breadcrumbs: BreadcrumbInput[] = [];
  const context: PluginContext = {
    options: {} as ResolvedMonitorOptions,
    captureEvent: () => null,
    addBreadcrumb: (breadcrumb) => void breadcrumbs.push(breadcrumb),
    startRequestSpan: () => new TraceContext().startRequestSpan(),
  };
  plugin = new BehaviorPlugin();
  plugin.setup(context);
  return breadcrumbs;
}

afterEach(() => {
  plugin?.teardown();
  plugin = undefined;
  document.body.innerHTML = '';
  history.replaceState({}, '', '/');
});

describe('click labels', () => {
  it('names the control the user clicked, including clicks on an icon inside it', () => {
    const host = mount('<button id="pay"><svg><path></path></svg> Pay   now</button>');
    expect(elementLabel(host.querySelector('button'))).toBe('button#pay “Pay now”');
    // target 是按钮里的图标时，向上找到按钮本身。
    expect(elementLabel(host.querySelector('path'))).toBe('button#pay “Pay now”');
  });

  it('records no text for clicks on containers that hold page data', () => {
    // 回归：点在列表容器上时，曾把容器 textContent 的前 80 个字（姓名、邮箱、电话、地址）写进面包屑。
    const host = mount(
      '<div class="orders"><div class="row">Wang Fang · wang.fang@example.com · +86 138 0013 0042</div></div>',
    );
    expect(elementLabel(host.querySelector('.orders'))).toBe('div.orders');
    expect(elementLabel(host.querySelector('.row'))).toBe('div.row');
  });

  it('uses a developer-written aria-label and honours data-tp-mask', () => {
    const host = mount(
      '<div role="dialog" aria-label="Close dialog" id="overlay"></div>' +
        '<section data-tp-mask><a href="/customers/42" class="customer">Wang Fang</a></section>',
    );
    expect(elementLabel(host.querySelector('#overlay'))).toBe('div#overlay “Close dialog”');
    expect(elementLabel(host.querySelector('a'))).toBe('a.customer');
  });

  it('records the name of a checkbox but never its state or a select’s value', () => {
    const host = mount(
      '<input type="checkbox" name="newsletter" checked><select name="country"><option selected>China</option></select>',
    );
    expect(elementLabel(host.querySelector('input'))).toBe('input “newsletter”');
    expect(elementLabel(host.querySelector('select'))).toBe('select “country”');
  });

  it('stops reading text once the label is long enough', () => {
    const host = mount(`<button>${'<span>segment </span>'.repeat(2_000)}</button>`);
    const label = elementLabel(host.querySelector('button'));
    expect(label.length).toBeLessThan(100);
    expect(label).toMatch(/^button “segment segment/);
  });

  it('adds a click breadcrumb through the capture-phase listener', () => {
    const breadcrumbs = install();
    const host = mount('<button id="checkout">Checkout</button>');
    host.querySelector('button')!.click();
    expect(breadcrumbs).toEqual([
      { type: 'click', category: 'ui.click', message: 'button#checkout “Checkout”' },
    ]);
  });
});

describe('navigation breadcrumbs', () => {
  it('records route changes but not query-only updates', () => {
    const breadcrumbs = install();
    // 搜索框逐字同步到查询参数：路由没变，不记。
    history.replaceState({}, '', '/?q=w');
    history.replaceState({}, '', '/?q=wa');
    history.pushState({}, '', '/orders/42');
    history.replaceState({}, '', '/orders/42?tab=items');
    history.pushState({}, '', '/orders/42#payment');

    expect(breadcrumbs.map((item) => item.message)).toEqual([
      'pushState → /orders/42',
      'pushState → /orders/42#payment',
    ]);
  });

  it('restores history methods on teardown only while its own wrappers are installed', () => {
    const originalPush = history.pushState;
    install();
    plugin!.teardown();
    expect(history.pushState).toBe(originalPush);

    const breadcrumbs = install();
    const ours = history.pushState;
    const theirs = function (this: History, ...args: Parameters<History['pushState']>) {
      return ours.apply(this, args);
    };
    history.pushState = theirs;
    plugin!.teardown();

    expect(history.pushState).toBe(theirs);
    history.pushState({}, '', '/after-teardown');
    expect(breadcrumbs).toEqual([]);
    history.pushState = originalPush;
  });
});
