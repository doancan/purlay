import { describe, expect, test } from 'bun:test';
import { ApiError } from '../data/errors';
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

  const decide = (retries: number | undefined, failures: number, error: unknown): boolean => {
    const retry = createQueryClient(retries === undefined ? {} : { retries }).getDefaultOptions()
      .queries?.retry;
    if (typeof retry !== 'function') throw new Error('the retry policy is a function');
    return retry(failures, error as Error);
  };

  test('retries once by default, and as often as a test says', () => {
    const offline = new ApiError(0, 'NETWORK', 'offline');
    expect(decide(undefined, 0, offline)).toBe(true);
    expect(decide(undefined, 1, offline)).toBe(false);
    expect(decide(0, 0, offline)).toBe(false);
    expect(decide(3, 2, offline)).toBe(true);
  });

  test('does not ask again for an answer that will not change', () => {
    expect(decide(undefined, 0, new ApiError(404, 'CHANNEL_NOT_FOUND', 'no'))).toBe(false);
    expect(decide(undefined, 0, new ApiError(401, 'UNAUTHENTICATED', 'no'))).toBe(false);
    expect(decide(undefined, 0, new Error('a bug'))).toBe(false);
    expect(decide(undefined, 0, new ApiError(503, 'DATABASE_UNAVAILABLE', 'busy'))).toBe(true);
  });
});
