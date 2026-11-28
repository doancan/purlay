/**
 * Spans of time and days of the calendar, said once.
 *
 * A calendar day is a `YYYY-MM-DD` string in the viewer's own zone, and the day after it is a day of the calendar,
 * never 24 hours (a daylight-saving change makes a day 23 or 25). The reminders, send-later, mute and status
 * presets, the search operators and the audit window all counted days; each had its own copy of these.
 */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The calendar day `days` after `day` (`YYYY-MM-DD`). */
export const dayAfter = (day: string, days = 1): string => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** The weekday of a calendar day, 0 (Sunday) to 6. */
export const weekdayOf = (day: string): number => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
