import { describe, expect, test } from 'bun:test';
import { BACKOFF, reconnectDelay } from './backoff';

describe('reconnect backoff', () => {
  test('doubles from one second, drawing from the top half of each step', () => {
    const lowest = [0, 1, 2, 3].map((attempt) => reconnectDelay(attempt, () => 0));
    const highest = [0, 1, 2, 3].map((attempt) => reconnectDelay(attempt, () => 1));
    expect(lowest).toEqual([500, 1_000, 2_000, 4_000]);
    expect(highest).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  test('is capped at thirty seconds however long the outage', () => {
    for (const attempt of [5, 6, 20, 1_000]) {
      expect(reconnectDelay(attempt, () => 1)).toBe(BACKOFF.capMs);
      expect(reconnectDelay(attempt, () => 0)).toBe(BACKOFF.capMs / 2);
    }
  });

  test('never returns an immediate retry', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(reconnectDelay(attempt, () => 0)).toBeGreaterThanOrEqual(BACKOFF.baseMs / 2);
    }
  });

  test('two clients with different draws do not retry in lockstep', () => {
    expect(reconnectDelay(3, () => 0.1)).not.toBe(reconnectDelay(3, () => 0.9));
  });
});
