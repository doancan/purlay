import { describe, expect, test } from 'bun:test';
import { parseQuota, QUOTA_BYTES_MAX, saidBytes } from './quota';

describe('a quota as an operator types it (D-173)', () => {
  test('whole bytes, or a whole number of a binary unit, with or without a space', () => {
    expect(parseQuota('1048576')).toBe(1048576n);
    expect(parseQuota('5GiB')).toBe(5n * 1024n ** 3n);
    expect(parseQuota(' 500 MiB ')).toBe(500n * 1024n ** 2n);
    expect(parseQuota('2TiB')).toBe(2n * 1024n ** 4n);
    expect(parseQuota('3KiB')).toBe(3072n);
    expect(parseQuota('7B')).toBe(7n);
    expect(parseQuota('0')).toBe(0n);
  });

  test('anything else is refused, never guessed: decimal units, fractions, signs, words, too much', () => {
    for (const typed of ['5GB', '1.5GiB', '-1', 'lots', '', '5 gib', '9999999999TiB']) {
      expect(parseQuota(typed)).toBeNull();
    }
    expect(parseQuota(String(QUOTA_BYTES_MAX))).toBe(QUOTA_BYTES_MAX);
    expect(parseQuota(String(QUOTA_BYTES_MAX + 1n))).toBeNull();
  });

  test('said in the largest unit it fills, to a tenth', () => {
    expect(saidBytes(0n)).toBe('0 B');
    expect(saidBytes(1023n)).toBe('1023 B');
    expect(saidBytes(1536n)).toBe('1.5 KiB');
    expect(saidBytes(5n * 1024n ** 3n)).toBe('5 GiB');
    expect(saidBytes(1288490188n)).toBe('1.2 GiB');
    expect(saidBytes(3n * 1024n ** 4n)).toBe('3 TiB');
    expect(saidBytes(2n * 1024n ** 2n)).toBe('2 MiB');
  });
});
