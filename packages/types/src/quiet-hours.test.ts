import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { isQuietAt, SetQuietHoursRequest, type QuietHours } from './quiet-hours';

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVENINGS: QuietHours = { from: 19 * 60, to: 9 * 60, days: WEEKDAYS };
const LUNCH: QuietHours = { from: 12 * 60, to: 13 * 60, days: WEEKDAYS };

/** 2026-11-06 is a Friday; Istanbul is UTC+3 all year. */
const istanbul = (iso: string): boolean => isQuietAt(EVENINGS, 'Europe/Istanbul', new Date(iso));

describe('a window within one day', () => {
  test('holds from its start up to, not including, its end, on its days only', () => {
    const at = (iso: string): boolean => isQuietAt(LUNCH, 'UTC', new Date(iso));
    expect(at('2026-11-06T11:59:00Z')).toBe(false);
    expect(at('2026-11-06T12:00:00Z')).toBe(true);
    expect(at('2026-11-06T12:59:00Z')).toBe(true);
    expect(at('2026-11-06T13:00:00Z')).toBe(false);
    expect(at('2026-11-07T12:30:00Z')).toBe(false); // Saturday
  });
});

describe('a window past midnight', () => {
  test('a chosen day’s evening runs into the next morning, whatever that day is', () => {
    expect(istanbul('2026-11-06T15:59:00Z')).toBe(false); // Fri 18:59
    expect(istanbul('2026-11-06T16:00:00Z')).toBe(true); // Fri 19:00
    expect(istanbul('2026-11-07T05:59:00Z')).toBe(true); // Sat 08:59, Friday's night
    expect(istanbul('2026-11-07T06:00:00Z')).toBe(false); // Sat 09:00
  });

  test('an unchosen day starts no night, and its morning belongs to the day before', () => {
    expect(istanbul('2026-11-07T17:00:00Z')).toBe(false); // Sat 20:00
    expect(istanbul('2026-11-08T05:00:00Z')).toBe(false); // Sun 08:00, Saturday's night
    expect(istanbul('2026-11-09T05:00:00Z')).toBe(false); // Mon 08:00, Sunday's night
    expect(istanbul('2026-11-10T05:00:00Z')).toBe(true); // Tue 08:00, Monday's night
  });
});

describe('the clock it is read on', () => {
  test('is the profile’s zone, not the server’s', () => {
    // 17:00 UTC on a Friday is 19:00 in Istanbul and 12:00 in New York.
    const now = new Date('2026-11-06T17:00:00Z');
    expect(isQuietAt(EVENINGS, 'Europe/Istanbul', now)).toBe(true);
    expect(isQuietAt(EVENINGS, 'America/New_York', now)).toBe(false);
  });

  test('follows a zone across its change of clocks', () => {
    // Berlin: 19:30 local is 17:30Z in October (UTC+2) and 18:30Z in November (UTC+1).
    const at = (iso: string): boolean => isQuietAt(EVENINGS, 'Europe/Berlin', new Date(iso));
    expect(at('2026-10-23T17:30:00Z')).toBe(true);
    expect(at('2026-11-06T17:30:00Z')).toBe(false);
    expect(at('2026-11-06T18:30:00Z')).toBe(true);
  });
});

test('equal ends are an empty window', () => {
  expect(
    isQuietAt({ from: 600, to: 600, days: [5] }, 'UTC', new Date('2026-11-06T10:00:00Z')),
  ).toBe(false);
});

describe('the contract', () => {
  test('takes minutes of a day and days of a week, each once', () => {
    expect(Value.Check(SetQuietHoursRequest, { quietHours: EVENINGS })).toBe(true);
    expect(Value.Check(SetQuietHoursRequest, { quietHours: null })).toBe(true);
    for (const bad of [
      { ...EVENINGS, from: 1440 },
      { ...EVENINGS, to: -1 },
      { ...EVENINGS, from: 12.5 },
      { ...EVENINGS, days: [] },
      { ...EVENINGS, days: [1, 1] },
      { ...EVENINGS, days: [7] },
      { ...EVENINGS, extra: true },
    ]) {
      expect(Value.Check(SetQuietHoursRequest, { quietHours: bad })).toBe(false);
    }
  });
});
