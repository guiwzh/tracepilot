import { SourceMapGenerator } from 'source-map';

/**
 * 虚构的「结账应用」源码与对应的 Source Map，供种子数据、截图和诊断评测使用。
 *
 * 种子事件的压缩栈指向固定的列号（例如 checkout.a81e93bd.js:1:420）。这里不手写原始行列，
 * 而是在源码文本里定位关键片段（needle），自动算出它所在的行和列——源码改动后映射仍然正确。
 * map 内联了 sourcesContent，排障 Agent 才能读到出错行附近的真实代码。
 */
export interface FrameMapping {
  /** 压缩文件里的列号，1 基，与浏览器栈里的列号一致。 */
  column: number;
  source: string;
  /** 在该源文件里定位出错位置的片段；取它第一次出现的位置。 */
  needle: string;
  name: string;
}

export interface SourceMapFixture {
  minifiedFile: string;
  sources: Record<string, string>;
  frames: FrameMapping[];
}

function locate(content: string, needle: string): { line: number; column: number } {
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const column = lines[index]!.indexOf(needle);
    if (column >= 0) return { line: index + 1, column };
  }
  throw new Error(`Fixture needle not found: ${needle}`);
}

export function buildSourceMap(fixture: SourceMapFixture): string {
  const generator = new SourceMapGenerator({ file: fixture.minifiedFile });
  for (const [source, content] of Object.entries(fixture.sources)) {
    generator.setSourceContent(source, content);
  }
  // source-map 要求同一生成行上的映射按列递增。
  for (const frame of [...fixture.frames].sort((left, right) => left.column - right.column)) {
    const content = fixture.sources[frame.source];
    if (content === undefined) throw new Error(`Unknown fixture source: ${frame.source}`);
    generator.addMapping({
      // 浏览器列号 1 基，SourceMapGenerator 0 基。
      generated: { line: 1, column: frame.column - 1 },
      original: locate(content, frame.needle),
      source: frame.source,
      name: frame.name,
    });
  }
  return generator.toString();
}

const totalSource = `import type { Cart } from '../api/types';
import { roundCents } from '../lib/money';

export interface TotalBreakdown {
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
}

function promotionAmount(cart: Cart): number {
  if (!cart.promotion) return 0;
  return cart.promotion.kind === 'percent'
    ? roundCents((cart.promotion.value / 100) * cart.items.length)
    : cart.promotion.value;
}

export function calculateTotal(cart: Cart): TotalBreakdown {
  const discount = promotionAmount(cart);
  const shipping = cart.shipping?.price ?? 0;
  const subtotal = cart.summary.total;
  const tax = roundCents(subtotal * (cart.taxRate ?? 0));
  return {
    subtotal,
    discount,
    shipping,
    tax,
    total: roundCents(subtotal - discount + shipping + tax),
  };
}
`;

const submitSource = `import { calculateTotal } from './total';
import { postOrder } from '../api/orders';
import type { CheckoutState } from './state';

export async function submitOrder(state: CheckoutState): Promise<string> {
  if (state.submitting) return state.pendingOrderId ?? '';
  const totals = calculateTotal(state.cart);
  const response = await postOrder({ cartId: state.cart.id, expectedTotal: totals.total });
  return response.orderId;
}
`;

/** 12 个次要根因各自抛错的位置；种子里的列号是 500 + 下标。 */
const stepFailures = [
  ['hydrateCheckoutState', 'Checkout state failed to hydrate'],
  ['applyPromotion', 'Promotion response contained an invalid discount'],
  ['validateAddress', 'Address validation service returned no candidates'],
  ['reserveDeliveryWindow', 'Selected delivery window is no longer available'],
  ['formatCurrency', 'Currency formatter received a non-numeric total'],
  ['normalizeCartItem', 'Cart item price was missing during checkout'],
  ['mountPaymentMethod', 'Payment method component failed to mount'],
  ['resolveShippingMethod', 'Shipping country is not supported'],
  ['loadTaxEstimate', 'Tax estimate request exceeded its deadline'],
  ['reserveInventory', 'Inventory reservation conflicted with another session'],
  ['reconcileCheckout', 'Checkout state diverged from the server snapshot'],
  ['connectPaymentFrame', 'Payment frame handshake was rejected'],
] as const;

const stepsSource = `${stepFailures
  .map(
    ([fn, message]) => `export function ${fn}(input: unknown): unknown {
  if (!input) {
    throw new Error('${message}');
  }
  return input;
}
`,
  )
  .join('\n')}`;

const inventorySource = `import type { InventoryResponse, InventoryLine } from '../api/types';
import { monitor } from '../monitoring';

export function normalizeInventory(response: InventoryResponse): InventoryLine[] {
  return response.lines.map((line) => {
    if (!line.warehouseId) {
      monitor.captureMessage('Inventory response omitted warehouseId', 'warning');
    }
    return { sku: line.sku, available: line.available, warehouseId: line.warehouseId ?? 'unknown' };
  });
}
`;

/** 2.4.1 的全部源文件（路径 → 内容），演示仓库里这个版本的代码与 map 内联的源码一致。 */
export function demoSourceFiles(): Record<string, string> {
  return Object.assign({}, ...DEMO_SOURCE_MAPS.map((fixture) => fixture.sources)) as Record<
    string,
    string
  >;
}

export const DEMO_SOURCE_MAPS: SourceMapFixture[] = [
  {
    minifiedFile: 'checkout.a81e93bd.js',
    sources: {
      'src/checkout/total.ts': totalSource,
      'src/checkout/submit.ts': submitSource,
      'src/checkout/steps.ts': stepsSource,
    },
    frames: [
      {
        column: 420,
        source: 'src/checkout/total.ts',
        needle: 'cart.summary.total',
        name: 'calculateTotal',
      },
      {
        column: 612,
        source: 'src/checkout/submit.ts',
        needle: 'calculateTotal(state.cart)',
        name: 'submitOrder',
      },
      ...stepFailures.map(([fn, message], index) => ({
        column: 500 + index,
        source: 'src/checkout/steps.ts',
        needle: `throw new Error('${message}')`,
        name: fn,
      })),
    ],
  },
  {
    minifiedFile: 'inventory.29ad00ef.js',
    sources: { 'src/inventory/normalize.ts': inventorySource },
    frames: [
      {
        column: 88,
        source: 'src/inventory/normalize.ts',
        needle: "monitor.captureMessage('Inventory response omitted warehouseId'",
        name: 'normalizeInventory',
      },
    ],
  },
];
