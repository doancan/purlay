/**
 * The two clocks: the one production reads, and the one tests pin.
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock, systemClock } from './clock';

describe('the clock', () => {
  test('the system clock is the current time, read afresh each call', () => {
    const before = Date.now();
    const read = systemClock.now().getTime();
    const after = Date.now();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(after);
    expect(systemClock.now()).not.toBe(systemClock.now());
  });

  test('a fixed clock does not move, and hands out copies a caller cannot change', () => {
    const instant = new Date('2026-09-09T12:00:00.000Z');
    const clock = fixedClock(instant);
    const first = clock.now();
    first.setFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-09-09T12:00:00.000Z');
  });
});
