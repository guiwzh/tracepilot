import type { MonitorEvent } from '@trace-pilot/shared';
import { describe, expect, it } from 'vitest';
import {
  defaultFingerprint,
  groupingFrame,
  isInAppFrame,
  issueFingerprint,
  legacyFingerprint,
  normalizeDisplayTitle,
  normalizeMessage,
  topStackFrame,
} from './fingerprint';

function failedRequest(method: string, url: string, status: number): MonitorEvent {
  return {
    eventId: `${method}-${status}`,
    eventType: 'network',
    timestamp: Date.now(),
    projectId: 'demo-project',
    release: '1.0.0',
    environment: 'production',
    page: { url: 'https://shop.test/cart' },
    device: { userAgent: 'Chrome/130' },
    payload: { method, url, status, duration: 12, success: false },
    breadcrumbs: [],
  };
}

function runtimeError(message: string, frame: string): MonitorEvent {
  return {
    ...failedRequest('GET', 'https://api.test/cart', 0),
    eventId: `error-${frame}`,
    eventType: 'error',
    payload: { name: 'Error', message, stack: `Error: ${message}\n    at ${frame}` },
  };
}

// 指纹测试确保动态 ID/时间戳被归一化，而不同根因仍保持不同摘要。
describe('issue fingerprint normalization', () => {
  it('collapses dynamic ids, UUIDs, hashes, and URL queries', () => {
    const first = normalizeMessage(
      'Order 39843992 failed for 550e8400-e29b-41d4-a716-446655440000 at app.a81e93bd.js https://a.test/cart?user=1',
    );
    const second = normalizeMessage(
      'Order 92740113 failed for 9c2f6171-858f-4b41-a6fe-7a54e431ff22 at app.2d9a773f.js https://a.test/cart?user=2',
    );
    expect(first).toBe(second);
  });

  it('collapses Vite-style base64 build hashes but keeps plain words', () => {
    const frame = (file: string) =>
      normalizeMessage(`at submit (https://cdn.test/assets/${file}:1:18234)`);
    expect(frame('index-C8pSMNq9.js')).toBe(frame('index-DcAjpfYV.js'));
    expect(normalizeMessage('app-checkout.js')).toBe('app-checkout.js');
  });

  it('keeps a readable title while replacing volatile identifiers', () => {
    expect(
      normalizeDisplayTitle('Order 39843992 failed for 550e8400-e29b-41d4-a716-446655440000'),
    ).toBe('Order {id} failed for {uuid}');
  });

  it('takes the top frame from the stack, not a message line that contains a path', () => {
    // 回归：消息里带 /（例如请求地址）时，消息行曾被当成栈顶帧，
    // 同一条消息、不同出错位置的两个错误被并成了一个 Issue。
    const message = 'Request to /api/cart failed';
    const submit = runtimeError(message, 'submit (https://shop.test/assets/checkout.js:1:612)');
    const pay = runtimeError(message, 'pay (https://shop.test/assets/pay.js:3:99)');
    expect(defaultFingerprint(submit)).not.toBe(defaultFingerprint(pay));
    expect(defaultFingerprint(submit)).toBe(
      defaultFingerprint(
        runtimeError(message, 'submit (https://shop.test/assets/checkout.js:1:612)'),
      ),
    );
    expect(topStackFrame(String(submit.payload.stack))).toBe(
      'at submit (https://shop.test/assets/checkout.js:1:612)',
    );
    // Firefox / Safari 的帧没有 at 前缀；没有任何栈帧时退回第一行。
    expect(topStackFrame('pay@https://shop.test/assets/pay.js:3:99')).toBe(
      'pay@https://shop.test/assets/pay.js:3:99',
    );
    expect(topStackFrame('Error: Request to /api/cart failed')).toBe(
      'error: request to /api/cart failed',
    );
  });

  it('keeps failed requests with different methods or statuses on one URL apart', () => {
    // 回归：曾经只按地址聚合，GET 404、POST 503 和连不上服务器被并成一个 Issue。
    const fingerprints = new Set(
      [
        failedRequest('GET', 'https://api.test/cart', 404),
        failedRequest('POST', 'https://api.test/cart', 503),
        failedRequest('POST', 'https://api.test/cart', 0),
      ].map((event) => defaultFingerprint(event)),
    );
    expect(fingerprints.size).toBe(3);
    // 同一种失败仍然聚合：查询参数和地址里的业务 ID 不影响指纹。
    expect(
      defaultFingerprint(failedRequest('GET', 'https://api.test/orders/81234567?t=1', 503)),
    ).toBe(defaultFingerprint(failedRequest('get', 'https://api.test/orders/99887766?t=2', 503)));
  });
});

describe('grouping after symbolication', () => {
  const error = runtimeError(
    'Cannot read properties of undefined',
    'unused (https://x.test/a.js:1:1)',
  );
  const mapped = (
    raw: string,
    line: number,
    contextLine: string | null,
    source = 'src/cart.ts',
  ) => ({
    raw,
    file: 'https://shop.test/assets/app.js',
    original: { source, line, name: 'calculateTotal', contextLine },
  });

  it('groups by the source location, not by the minified name, column or line', () => {
    // 两次构建：压缩后的函数名、列号都变了，出错那行代码前面又加了两行，但出错的是同一行代码。
    const before = [
      mapped(
        'at t (https://shop.test/assets/app.a1.js:1:420)',
        22,
        'const subtotal = cart.summary.total;',
      ),
    ];
    const after = [
      mapped(
        'at n (https://shop.test/assets/app.b2.js:1:388)',
        24,
        'const  subtotal = cart.summary.total;',
      ),
    ];
    expect(defaultFingerprint(error, before)).toBe(defaultFingerprint(error, after));
    // 出错的代码变了，就是另一个问题。
    const other = [
      mapped(
        'at t (https://shop.test/assets/app.a1.js:1:420)',
        22,
        'const tax = cart.taxRate.value;',
      ),
    ];
    expect(defaultFingerprint(error, other)).not.toBe(defaultFingerprint(error, before));
  });

  it('skips dependency frames when choosing the frame to group by', () => {
    const app = mapped('at t (https://shop.test/assets/app.js:1:420)', 22, 'renderCart(cart);');
    const react = (name: string) => ({
      raw: `at ${name} (https://shop.test/assets/vendor.js:1:99)`,
      file: 'https://shop.test/assets/vendor.js',
      original: {
        source: `webpack://shop/./node_modules/react-dom/cjs/${name}.js`,
        line: 10,
        name,
        contextLine: 'throw error;',
      },
    });
    expect(groupingFrame([react('renderWithHooks'), app])).toBe(groupingFrame([app]));
    expect(defaultFingerprint(error, [react('renderWithHooks'), app])).toBe(
      defaultFingerprint(error, [react('commitRoot'), app]),
    );
    expect(isInAppFrame(react('commitRoot'))).toBe(false);
  });

  it('lets the SDK regroup with a custom fingerprint built on the default one', () => {
    const frames = [mapped('at t (https://shop.test/assets/app.js:1:420)', 22, 'pay();')];
    const tenant = (name: string) =>
      issueFingerprint({ ...error, fingerprint: ['{{ default }}', name] }, frames);
    expect(tenant('a')).toMatchObject({ algorithm: 'custom' });
    expect(tenant('a').fingerprint).not.toBe(tenant('b').fingerprint);
    expect(tenant('a').fingerprint).not.toBe(issueFingerprint(error, frames).fingerprint);
    // 不含占位符的自定义指纹与错误本身无关：不同位置抛出的同一类错误归到一起。
    const timeout = (message: string) =>
      issueFingerprint({
        ...runtimeError(message, 'x (https://a.test/b.js:1:2)'),
        fingerprint: ['checkout-timeout'],
      });
    expect(timeout('first').fingerprint).toBe(timeout('second').fingerprint);
    // 没有栈帧时与 v1 用同一个栈顶帧，但两个算法的指纹不会相撞。
    expect(defaultFingerprint(error)).not.toBe(legacyFingerprint(error));
  });
});
