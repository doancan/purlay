import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { CATCH_UP_PAGE, CatchUpQuery, ChannelCatchUp } from './catch-up';

describe('private channel catch-up contract', () => {
  test('bounds both pages and refuses unknown input', () => {
    expect(CATCH_UP_PAGE).toBe(20);
    for (const value of [{}, { limit: 1 }, { limit: 100 }])
      expect(Value.Check(CatchUpQuery, value)).toBe(true);
    for (const value of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: '20' },
      { afterThread: 'other' },
      { userId: 'other' },
    ]) {
      expect(Value.Check(CatchUpQuery, value)).toBe(false);
    }
  });

  test('an empty page describes roots and threads independently', () => {
    const page = { roots: { data: [], nextCursor: null }, threads: [], nextThreadCursor: null };
    expect(Value.Check(ChannelCatchUp, page)).toBe(true);
    expect(Value.Check(ChannelCatchUp, { ...page, roots: [] })).toBe(false);
  });
});
