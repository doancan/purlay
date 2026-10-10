import { describe, expect, test } from 'bun:test';
import { STALE_AFTER_MS, createQueryClient } from './query-client';

describe('the query client', () => {
  test('does not refetch when the window regains focus: the socket keeps a channel current', () => {
    const options = createQueryClient().getDefaultOptions().queries;
    expect(options?.refetchOnWindowFocus).toBe(false);
  });

  test('keeps a fetched page fresh long enough that switching back is instant', () => {
    const options = createQueryClient().getDefaultOptions().queries;
    expect(options?.staleTime).toBe(STALE_AFTER_MS);
  });

  test('retries once by default, and as often as a test says', () => {
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(1);
    expect(createQueryClient({ retries: 0 }).getDefaultOptions().queries?.retry).toBe(0);
  });
});
