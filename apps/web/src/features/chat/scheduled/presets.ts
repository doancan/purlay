/**
 * The times "Send later" offers, and the rules for one typed by hand.
 *
 * Every time here is a wall-clock time in the viewer's zone, turned into an instant by the
 * formatters (`dayAt`), which know the zone's clock changes. Pure: the caller passes `now`, so a
 * test names the instant, the zone and the weekday.
 */
import { SCHEDULE_AHEAD_MAX_DAYS } from '@purlay/types';
import type { Formatters } from '../../../i18n/format';
import type { Translate } from '../../../i18n/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The morning a preset sends at. */
const MORNING_HOUR = 9;
const SUNDAY = 0;
const MONDAY = 1;
const DAYS_IN_WEEK = 7;

/** How soon the dialog lets a time be: the server's own floor is five seconds, which a typed minute never reaches. */
const SOONEST_MS = MINUTE_MS;

export type PresetId = 'hour' | 'tomorrow' | 'monday';

export interface SchedulePreset {
  readonly id: PresetId;
  readonly at: Date;
}

/** `YYYY-MM-DD` a number of calendar days on: a calendar's arithmetic, so a day with 23 or 25 hours is still one. */
const addDays = (isoDay: string, days: number): string => {
  const [year = 0, month = 1, day = 1] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

const weekdayOf = (isoDay: string): number => new Date(`${isoDay}T00:00:00Z`).getUTCDay();

/**
 * An hour from now, tomorrow morning and the next Monday morning. Monday is left out on a Sunday,
 * when it is tomorrow, and on a Monday, when "Monday" would read as today.
 */
export const schedulePresets = (now: Date, format: Formatters): readonly SchedulePreset[] => {
  const today = format.isoDay(now);
  const morning = (isoDay: string): Date => new Date(format.dayAt(isoDay, MORNING_HOUR, 0));
  const presets: SchedulePreset[] = [
    { id: 'hour', at: new Date(now.getTime() + HOUR_MS) },
    { id: 'tomorrow', at: morning(addDays(today, 1)) },
  ];
  const weekday = weekdayOf(today);
  if (weekday !== SUNDAY && weekday !== MONDAY) {
    const untilMonday = DAYS_IN_WEEK + MONDAY - weekday;
    presets.push({ id: 'monday', at: morning(addDays(today, untilMonday)) });
  }
  return presets;
};

/** What a datetime-local field holds for an instant: its wall-clock time here, to the minute. */
export const toInputValue = (at: Date, format: Formatters): string =>
  `${format.isoDay(at)}T${format.clock(at)}`;

const INPUT_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The instant a datetime-local field's value means here, or null when it is empty or not a real date and time. */
export const fromInputValue = (value: string, format: Formatters): Date | null => {
  const parts = INPUT_SHAPE.exec(value);
  if (parts === null) return null;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }
  // A day the month does not have rolls over in a calendar's arithmetic; one that does not read back is not a day.
  const isoDay = parts.slice(1, 4).join('-');
  if (addDays(isoDay, 0) !== isoDay) return null;
  return new Date(format.dayAt(isoDay, hour, minute));
};

export type SendAtCheck = 'ok' | 'invalid' | 'tooSoon' | 'tooFar';

/** Whether a time can be asked of the server: a real time, at least a minute away and at most a year. */
export const checkSendAt = (at: Date | null, now: Date): SendAtCheck => {
  if (at === null || Number.isNaN(at.getTime())) return 'invalid';
  const ahead = at.getTime() - now.getTime();
  if (ahead < SOONEST_MS) return 'tooSoon';
  return ahead > SCHEDULE_AHEAD_MAX_DAYS * DAY_MS ? 'tooFar' : 'ok';
};

/** The earliest and the latest a field may hold, as the field's own values. */
export const inputBounds = (
  now: Date,
  format: Formatters,
): { readonly min: string; readonly max: string } => ({
  min: toInputValue(new Date(now.getTime() + SOONEST_MS), format),
  max: toInputValue(new Date(now.getTime() + SCHEDULE_AHEAD_MAX_DAYS * DAY_MS), format),
});

/** A time in words: today or tomorrow with the hour, any other day by its date. */
export const describeWhen = (
  at: Date,
  now: Date,
  format: Formatters,
  t: Translate,
): string => {
  const time = format.clock(at);
  const day = format.isoDay(at);
  const today = format.isoDay(now);
  if (day === today) return t('scheduled.when.today', { time });
  if (day === addDays(today, 1)) return t('scheduled.when.tomorrow', { time });
  const named = format.day(at, now, {
    today: t('message.today'),
    yesterday: t('message.yesterday'),
  });
  return t('scheduled.when.on', { day: named, time });
};
