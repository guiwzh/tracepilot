import type { MonitorClient } from '@trace-pilot/monitor-sdk';

/** 场景能操作的东西：SDK 实例，以及让页面上的 React 组件在渲染时出错。 */
export interface Lab {
  monitor: MonitorClient;
  crashWidget(): void;
}

/**
 * 每个场景都通过浏览器真实 API 制造信号，验证 SDK 插件而不是伪造 Dashboard 数据。
 * tests/e2e/playground.spec.ts 逐个点击这些场景，并核对服务端最终收到了什么。
 *
 * /__lab/* 接口由 Playground 自己的开发（预览）服务器提供（见 vite.config.ts），生产服务端不暴露它们。
 */
export interface Scenario {
  id: string;
  number: string;
  title: string;
  description: string;
  /** 同步调用：场景 01 需要在点击处理函数里直接抛错。 */
  run(lab: Lab): void | Promise<unknown>;
}

export const scenarios: Scenario[] = [
  {
    id: 'exception',
    number: '01',
    title: 'Runtime exception',
    description:
      'Throws inside the React click handler. React 19 reports it through window.error, where the SDK picks it up.',
    run: () => {
      throw new TypeError(
        `Cannot read properties of undefined (reading 'total') — order ${Date.now()}`,
      );
    },
  },
  {
    id: 'promise',
    number: '02',
    title: 'Unhandled promise',
    description: 'Rejects a payment promise without a catch handler.',
    run: () => {
      void Promise.reject(new Error(`Payment intent ${crypto.randomUUID()} was not initialized`));
    },
  },
  {
    id: 'resource',
    number: '03',
    title: 'Broken resource',
    description: 'Adds an image whose URL returns no asset.',
    run: () => {
      // DOM 资源加载失败使用 error 捕获阶段传播，与普通 JavaScript 异常机制不同。
      const image = new Image();
      image.alt = 'Deliberately missing checkout badge';
      image.src = `/__lab/missing-checkout-badge-${Date.now()}.png`;
      image.hidden = true;
      document.body.append(image);
      window.setTimeout(() => image.remove(), 2_000);
    },
  },
  {
    id: 'fetch',
    number: '04',
    title: 'Fetch 503',
    description:
      'Payment authorization answers 503. The ?token= in its address is stripped before the event leaves the page.',
    run: () => fetch('/__lab/payment?token=demo-secret', { method: 'POST' }),
  },
  {
    id: 'xhr',
    number: '05',
    title: 'XHR 503',
    description: 'Exercises the legacy request instrumentation path.',
    run: () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/__lab/inventory?source=xhr');
      xhr.send();
    },
  },
  {
    id: 'business',
    number: '06',
    title: 'Business error (HTTP 200)',
    description:
      'The coupon API answers 200 with { code: 40012 } in the body. detectBusinessError reads a clone of the JSON body and reports it as a failed request.',
    run: () => fetch('/__lab/coupon', { method: 'POST' }),
  },
  {
    id: 'route',
    number: '07',
    title: 'SPA route change',
    description:
      'Navigates without reloading. It is not an issue on its own; it shows up as a breadcrumb on the next event.',
    run: () => {
      const search = new URLSearchParams(location.search);
      search.set('session', String(Date.now()));
      history.pushState({}, '', `/checkout/review?${search}`);
    },
  },
  {
    id: 'warning',
    number: '08',
    title: 'Captured warning',
    description:
      'An application-owned warning with context. beforeSend removes the customer email before it is sent.',
    run: ({ monitor }) => {
      monitor.captureEvent('error', {
        name: 'Message',
        message: 'Inventory response omitted warehouseId',
        level: 'warning',
        cartId: 'cart-8842',
        customerEmail: 'wang.fang@example.com',
      });
    },
  },
  {
    id: 'react',
    number: '09',
    title: 'React render error',
    description:
      'The order summary widget crashes while rendering. Its error boundary catches it, so window.error never fires; the root onCaughtError hook reports it with the component stack.',
    run: ({ crashWidget }) => crashWidget(),
  },
  {
    id: 'abort',
    number: '10',
    title: 'Cancelled request',
    description:
      'Starts a slow request and aborts it, as an unmounting component would. It stays a breadcrumb and never becomes an issue.',
    run: async () => {
      const controller = new AbortController();
      const request = fetch('/__lab/slow', { signal: controller.signal });
      window.setTimeout(() => controller.abort(), 50);
      await request;
    },
  },
  {
    id: 'storm',
    number: '11',
    title: 'Error storm',
    description:
      'Throws the same error 20 times and breaks 12 thumbnails at once. Short-window deduplication sends one event of each.',
    run: () => {
      for (let index = 0; index < 20; index += 1) {
        window.setTimeout(() => {
          throw new Error('Inventory sync failed for warehouse WH-EAST');
        });
      }
      for (let index = 1; index <= 12; index += 1) {
        const image = new Image();
        image.src = `/__lab/thumbs/product-${index}.png`;
        image.hidden = true;
        document.body.append(image);
        window.setTimeout(() => image.remove(), 2_000);
      }
    },
  },
  {
    id: 'blank',
    number: '12',
    title: 'Blank page after navigation',
    description:
      'Navigates to /checkout/blank and renders nothing there. No error is thrown; the white screen plugin samples 18 points, finds only empty containers three checks in a row and reports it. The page comes back after a few seconds.',
    run: () => {
      const root = document.getElementById('root');
      const previous = `${location.pathname}${location.search}${location.hash}`;
      history.pushState({}, '', `/checkout/blank${location.search}`);
      if (root) root.style.display = 'none';
      window.setTimeout(() => {
        if (root) root.style.display = '';
        history.pushState({}, '', previous);
      }, 3_000);
    },
  },
  {
    id: 'exit',
    number: '13',
    title: 'Leave with queued events',
    description:
      'Queues two messages and reloads at once. Whatever has not been sent yet leaves through sendBeacon on the way out.',
    run: ({ monitor }) => {
      monitor.captureMessage('Checkout draft queued before leaving', 'warning');
      monitor.captureMessage('Address form left half-filled', 'info');
      location.reload();
    },
  },
];
