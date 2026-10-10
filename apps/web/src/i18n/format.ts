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
}

export interface DayWords {
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
  const numbers = new Intl.NumberFormat(locale);

  // Yesterday is a calendar day, not 24 hours ago: on the two days a year the
  // clocks change, those are different days.
  const dayBefore = (isoDay: string): string => {
    const [y = 0, m = 1, d = 1] = isoDay.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  };
  const sameDay = (a: Date, b: Date): boolean => calendarDay.format(a) === calendarDay.format(b);
  const sameYear = (a: Date, b: Date): boolean => year.format(a) === year.format(b);

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
  };
};
