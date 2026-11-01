import { describe, expect, test } from 'bun:test';
import { addDays, addMonths, isDay, monthGrid, monthOf } from './calendar-month';

describe('calendar month', () => {
  test('isDay accepts real days only', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-2-3')).toBe(false);
  });

  test('addDays crosses months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('addMonths holds to the last day of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
    expect(monthOf('2026-03-15')).toBe('2026-03');
  });

  test('the grid is whole Monday-first weeks covering the month', () => {
    const weeks = monthGrid('2026-11-10');
    expect(weeks[0]?.[0]).toBe('2026-10-26');
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks.flat()).toContain('2026-11-30');
    expect(weeks.length).toBe(6);
    expect(monthGrid('2027-02-01').length).toBe(4);
  });
});
