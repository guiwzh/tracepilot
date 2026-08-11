import { describe, expect, it } from 'vitest';
import { normalizeDisplayTitle, normalizeMessage } from './fingerprint';

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

  it('keeps a readable title while replacing volatile identifiers', () => {
    expect(normalizeDisplayTitle('Order 39843992 failed for 550e8400-e29b-41d4-a716-446655440000')).toBe(
      'Order {id} failed for {uuid}',
    );
  });
});
