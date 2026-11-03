import { describe, expect, test } from 'bun:test';
import { PAGE_LIMIT } from '@purlay/types';
import { limitOf } from './pagination';

describe('the size of a page', () => {
  test('is the contract’s default when the request names none', () => {
    expect(limitOf({})).toBe(PAGE_LIMIT.default);
    expect(limitOf({ limit: undefined })).toBe(PAGE_LIMIT.default);
  });

  test('is what was asked, kept within one and the contract’s maximum', () => {
    expect(limitOf({ limit: 7 })).toBe(7);
    expect(limitOf({ limit: 0 })).toBe(1);
    expect(limitOf({ limit: -5 })).toBe(1);
    expect(limitOf({ limit: PAGE_LIMIT.max + 1 })).toBe(PAGE_LIMIT.max);
  });
});
