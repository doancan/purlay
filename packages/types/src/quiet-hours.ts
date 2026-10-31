/**
 * Quiet hours (D-234): the hours of the week a person is not to be interrupted, every week, in the time
 * zone of their profile. What Deep Work is for an afternoon (D-15), this is for evenings and weekends:
 * the server holds back what would interrupt them, and the open page says nothing either.
 *
 * Minutes after midnight, so a window is two numbers and a set of days; `from` later than `to` runs past
 * midnight (19:00 → 09:00), and its night belongs to the day it began — Friday's evening holds through
 * Saturday's morning, Saturday's does not exist unless Saturday is chosen. One function decides it, for
 * the server and the client alike.
 */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient } from './models';

export const MINUTES_PER_DAY = 1440;

/** 0 is Sunday, as `Date.getDay()` and `Intl` count them. */
export const QuietDay = Type.Integer({ minimum: 0, maximum: 6 });

export const QuietHours = FromClient({
  from: Type.Integer({ minimum: 0, maximum: MINUTES_PER_DAY - 1 }),
  to: Type.Integer({ minimum: 0, maximum: MINUTES_PER_DAY - 1 }),
  days: Type.Array(QuietDay, { minItems: 1, maxItems: 7, uniqueItems: true }),
});
export type QuietHours = Static<typeof QuietHours>;

/** `PUT /api/me/quiet-hours` — the window, or `null` for none. */
export const SetQuietHoursRequest = FromClient({
  quietHours: Type.Union([QuietHours, Type.Null()]),
});
export type SetQuietHoursRequest = Static<typeof SetQuietHoursRequest>;

/** `GET` and `PUT /api/me/quiet-hours` — the window, and the profile's time zone it is read in. */
export const QuietHoursSetting = Type.Object({
  quietHours: Type.Union([QuietHours, Type.Null()]),
  timeZone: Type.Union([Type.String(), Type.Null()]),
});
export type QuietHoursSetting = Static<typeof QuietHoursSetting>;

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The weekday and the minute of the day at `now`, on the clock of `timeZone`. */
const localTime = (
  timeZone: string,
  now: Date,
): { readonly day: number; readonly minute: number } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((each) => each.type === type)?.value ?? '';
  return {
    day: WEEKDAYS[part('weekday')] ?? 0,
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  };
};

/** Whether `now` falls in the window, read in `timeZone`. A window whose two ends are equal is empty. */
export const isQuietAt = (hours: QuietHours, timeZone: string, now: Date): boolean => {
  const { day, minute } = localTime(timeZone, now);
  const on = (weekday: number): boolean => hours.days.includes(weekday);
  if (hours.from < hours.to) return on(day) && minute >= hours.from && minute < hours.to;
  if (hours.from > hours.to) {
    return (on(day) && minute >= hours.from) || (on((day + 6) % 7) && minute < hours.to);
  }
  return false;
};
