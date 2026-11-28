import { describe, expect, test } from 'bun:test';
import { DAY_MS, dayAfter, HOUR_MS, MINUTE_MS, weekdayOf } from './time';

describe('spans and calendar days', () => {
  test('a day is 24 hours of 60 minutes', () => {
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
    expect(DAY_MS).toBe(86_400_000);
  });

  test('the day after crosses months and years, and a leap day, as the calendar does', () => {
    expect(dayAfter('2026-01-31')).toBe('2026-02-01');
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
    expect(dayAfter('2028-02-28')).toBe('2028-02-29');
    expect(dayAfter('2026-03-28', 7)).toBe('2026-04-04');
  });

  test('a weekday is Sunday 0 to Saturday 6', () => {
    expect(weekdayOf('2026-11-28')).toBe(6);
    expect(weekdayOf('2026-11-29')).toBe(0);
  });
});
