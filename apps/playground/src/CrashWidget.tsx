import { Component, type ReactNode } from 'react';

interface Order {
  lineItems: string[];
}

class OrderSummaryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <p className="widget-state is-failed">
        Order summary unavailable — the error boundary caught a render error.
      </p>
    ) : (
      this.props.children
    );
  }
}

function CheckoutSummary({ order }: { order?: Order }) {
  // 接口少返回了一层数据时，这里在渲染阶段读取 undefined 的字段而抛出。
  return <p className="widget-state">{order!.lineItems.length} line items ready for checkout</p>;
}

/**
 * 场景 08 的「受害组件」。被错误边界捕获的渲染错误不会触发 window.error，
 * 只有 main.tsx 里接到根节点 onCaughtError 的 reactErrorHandler 能把它交给 SDK。
 */
export function CrashWidget({ crashes }: { crashes: number }) {
  // key 变化让错误边界重新挂载：每次触发都是一次新的渲染错误，而不是停留在已经失败的状态。
  return (
    <OrderSummaryBoundary key={crashes}>
      <CheckoutSummary order={crashes > 0 ? undefined : { lineItems: ['sku-1', 'sku-2'] }} />
    </OrderSummaryBoundary>
  );
}
