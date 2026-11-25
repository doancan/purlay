/** The arithmetic of a limit, and the shape of its kinds, which the table's check holds to the same pattern. */
import { describe, expect, test } from 'bun:test';
import { QUOTA_KINDS, QUOTA_LIMIT_MAX, isQuotaKind, passes } from './quotas';

describe('whether one more passes a limit', () => {
  test.each([
    [null, 1_000_000, 1_000_000, false],
    [10, 9, 1, false],
    [10, 10, 1, true],
    [10, 5, 5, false],
    [10, 5, 6, true],
    [0, 0, 1, true],
    [0, 0, 0, false],
  ])('limit %p, held %p, adding %p: passes is %p', (limit, held, adding, wanted) => {
    expect(passes(limit, held, adding)).toBe(wanted);
  });
});

describe('the kinds of limit', () => {
  test('are keys of the shape the table accepts: a name of the core, or a module’s and a name', () => {
    for (const kind of Object.keys(QUOTA_KINDS)) {
      expect(kind).toMatch(/^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$/);
      expect(kind.length).toBeLessThanOrEqual(48);
    }
  });

  test('are known by name, and nothing else is', () => {
    expect(isQuotaKind('deliveries_per_minute')).toBe(true);
    expect(isQuotaKind('issues:rows')).toBe(true);
    expect(isQuotaKind('toString')).toBe(false);
    expect(isQuotaKind('constructor')).toBe(false);
    expect(isQuotaKind('storage_bytes')).toBe(false);
  });

  test('may be set to the largest number JSON and the column both hold exactly', () => {
    expect(QUOTA_LIMIT_MAX).toBe(9_007_199_254_740_991);
  });
});
