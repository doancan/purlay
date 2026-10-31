/**
 * Dates, times and numbers — all of it `Intl`, none of it ours (D-41).
 *
 * **The rule for a message's timestamp is `UX.md` §3's**: relative under an hour
 * ("12m ago"), then `HH:mm` for the rest of the day, then `MMM D` — with the year
 * only when it is not this one, because "Oct 6" a year ago is a different day
 * than it reads as. The absolute time is always available (a tooltip), so the
 * short form can afford to be vague.
 *
 * `HH:mm` is a 24-hour clock in every locale: this is read by people scanning a
 * log for "around two", and a clock that changes shape with the locale makes the
 * same channel read differently on two screens.
 *
 * Formatters are built once per locale and reused — `Intl` constructors are the
 * expensive part, and a channel renders hundreds of timestamps. The time zone is
 * an argument so a test names one; in the browser it is the person's own.
 */
import type { Locale } from './types';

export interface Formatters {
  /** The short timestamp a message row shows. */
  readonly time: (value: Date | string, now: Date) => string;
  /** The full time, for hover and for assistive technology. */
  readonly absolute: (value: Date | string) => string;
  /** The label of a day divider; `today` and `yesterday` are the catalogue's words. */
  readonly day: (value: Date | string, now: Date, words: DayWords) => string;
  readonly number: (value: number) => string;
  /** Names joined as the language joins them: "Alice, Bob and 3 others", "Alice, Bob ve 3 kişi daha". */
  readonly list: (items: readonly string[]) => string;
  /** A size: bytes, then kilobytes, megabytes and gigabytes of 1024, one decimal at most. */
  readonly bytes: (value: number) => string;
  /** The calendar day an instant falls on here, as `YYYY-MM-DD` — what a date field holds. */
  readonly isoDay: (value: Date | string) => string;
  /**
   * The instant a calendar day (`YYYY-MM-DD`) begins here, as the API's UTC timestamp: the first
   * moment whose day is that one, so a midnight a clock change skips begins at the hour after it.
   */
  readonly dayStart: (isoDay: string) => string;
}

interface DayWords {
  readonly today: string;
  readonly yesterday: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

export const createFormatters = (locale: Locale, timeZone?: string): Formatters => {
  const zone = timeZone === undefined ? {} : { timeZone };
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  const clock = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...zone,
  });
  const monthDay = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...zone });
  const monthDayYear = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...zone,
  });
  const weekdayDay = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...zone,
  });
  const full = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...zone,
  });
  const calendarDay = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...zone,
  });
  const year = new Intl.DateTimeFormat('en-CA', { year: 'numeric', ...zone });
  const wall = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...zone,
  });
  const numbers = new Intl.NumberFormat(locale);
  const names = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  const inUnit = (
    unit: 'byte' | 'kilobyte' | 'megabyte' | 'gigabyte',
    unitDisplay: 'short' | 'long' = 'short',
  ): Intl.NumberFormat =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay, maximumFractionDigits: 1 });
  // Bytes in words: the short unit is "byte" whatever the count ("0 byte"); the long one is the
  // language's plural ("0 bytes", "1 byte"; "0 bayt"). The larger units keep their symbols.
  const [inBytes, inKilobytes, inMegabytes, inGigabytes] = [
    inUnit('byte', 'long'),
    inUnit('kilobyte'),
    inUnit('megabyte'),
    inUnit('gigabyte'),
  ];

  // Yesterday is a calendar day, not 24 hours ago: on the two days a year the
  // clocks change, those are different days.
  const dayBefore = (isoDay: string): string => {
    const [y = 0, m = 1, d = 1] = isoDay.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  };
  const sameDay = (a: Date, b: Date): boolean => calendarDay.format(a) === calendarDay.format(b);
  const sameYear = (a: Date, b: Date): boolean => year.format(a) === year.format(b);

  // `Date.UTC` reads a year under 100 as 19xx; a date field holds `0002` while a year is typed.
  const utc = (y: number, m: number, d: number, h = 0, min = 0, sec = 0): number =>
    new Date(Date.UTC(2000, 0, 1, h, min, sec)).setUTCFullYear(y, m - 1, d);
  // The wall clock here at an instant, as numbers: year, month, day, hour, minute, second.
  const wallAt = (at: number): readonly number[] => {
    const parts = wall.formatToParts(at);
    return (['year', 'month', 'day', 'hour', 'minute', 'second'] as const).map((type) =>
      Number(parts.find((each) => each.type === type)?.value),
    );
  };
  const isoDay = (at: number): string => {
    const [y = 0, m = 1, d = 1] = wallAt(at);
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  // How far the clock here is ahead of UTC at an instant: the wall time read back as if it were UTC.
  const offsetAt = (at: number): number => {
    const [y = 0, m = 1, d = 1, h = 0, min = 0, sec = 0] = wallAt(at);
    return utc(y, m, d, h, min, sec) - (at - (at % 1000));
  };
  const dayStart = (day: string): string => {
    const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
    const asUtc = utc(y, m, d);
    // The offset at UTC midnight is a guess; the offset at the guess is right unless a clock change
    // falls between them. Of the two, the earliest moment that is already on that day here.
    const guess = asUtc - offsetAt(asUtc);
    const candidates = [guess, asUtc - offsetAt(guess)].sort((a, b) => a - b);
    const start = candidates.find((at) => isoDay(at) === day) ?? guess;
    return new Date(start).toISOString();
  };

  return {
    time: (value, now): string => {
      const date = asDate(value);
      // A timestamp from a clock a few seconds ahead of ours is "now", not "in 3s".
      const age = Math.max(0, now.getTime() - date.getTime());
      if (age < MINUTE) return relative.format(0, 'second');
      if (age < HOUR) return relative.format(-Math.floor(age / MINUTE), 'minute');
      if (sameDay(date, now)) return clock.format(date);
      return (sameYear(date, now) ? monthDay : monthDayYear).format(date);
    },
    absolute: (value) => full.format(asDate(value)),
    day: (value, now, words): string => {
      const date = asDate(value);
      if (sameDay(date, now)) return words.today;
      if (calendarDay.format(date) === dayBefore(calendarDay.format(now))) return words.yesterday;
      return (sameYear(date, now) ? weekdayDay : monthDayYear).format(date);
    },
    number: (value) => numbers.format(value),
    list: (items) => names.format(items),
    bytes: (value) =>
      value < 1024
        ? inBytes.format(value)
        : value < 1024 * 1024
          ? inKilobytes.format(value / 1024)
          : value < 1024 * 1024 * 1024
            ? inMegabytes.format(value / (1024 * 1024))
            : inGigabytes.format(value / (1024 * 1024 * 1024)),
    isoDay: (value) => isoDay(asDate(value).getTime()),
    dayStart,
  };
};
