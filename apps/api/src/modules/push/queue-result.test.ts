/** Backoff and provider retry guidance are bounded, including malformed and extreme inputs. */
import { describe, expect, test } from 'bun:test';
import { pushRetryDelay } from './queue-result';

const NOW = new Date('2026-11-11T12:00:00Z');
describe('durable push backoff', () => {
  test.each([
    [1, undefined, 5_000],
    [2, undefined, 10_000],
    [8, undefined, 640_000],
    [20, undefined, 900_000],
    [1, '90', 90_000],
    [1, '0', 5_000],
    [1, '-1', 5_000],
    [1, 'invalid', 5_000],
    [1, '999999999999999999999999', 3_600_000],
    [1, '1'.repeat(400), 5_000],
    [1, 'Wed, 11 Nov 2026 12:02:00 GMT', 120_000],
    [1, 'Wed, 11 Nov 2026 11:00:00 GMT', 5_000],
  ] as const)('attempt %s with %s waits %s ms', (attempt, header, expected) => {
    expect(pushRetryDelay(attempt, header, NOW)).toBe(expected);
  });
});
