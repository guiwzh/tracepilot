import type { MonitorEvent } from '@trace-pilot/shared';
import { describe, expect, it } from 'vitest';
import { eventFingerprint, normalizeDisplayTitle, normalizeMessage } from './fingerprint';

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

  it('keeps failed requests with different methods or statuses on one URL apart', () => {
    // 回归：曾经只按地址聚合，GET 404、POST 503 和连不上服务器被并成一个 Issue。
    const fingerprints = new Set(
      [
        failedRequest('GET', 'https://api.test/cart', 404),
        failedRequest('POST', 'https://api.test/cart', 503),
        failedRequest('POST', 'https://api.test/cart', 0),
      ].map(eventFingerprint),
    );
    expect(fingerprints.size).toBe(3);
    // 同一种失败仍然聚合：查询参数和地址里的业务 ID 不影响指纹。
    expect(
      eventFingerprint(failedRequest('GET', 'https://api.test/orders/81234567?t=1', 503)),
    ).toBe(eventFingerprint(failedRequest('get', 'https://api.test/orders/99887766?t=2', 503)));
  });
});
