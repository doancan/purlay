/**
 * The times "Send later" offers, and the rules for one typed by hand.
 *
 * Every time here is a wall-clock time in the viewer's zone, turned into an instant by the
 * formatters (`dayAt`), which know the zone's clock changes. Pure: the caller passes `now`, so a
 * test names the instant, the zone and the weekday.
 */
import type { Formatters } from '../../../i18n/format';
import type { Translate } from '../../../i18n/types';

const HOUR_MS = 60 * 60_000;

/** The morning a preset sends at. */
const MORNING_HOUR = 9;
const SUNDAY = 0;
const MONDAY = 1;
const DAYS_IN_WEEK = 7;

export type PresetId = 'hour' | 'tomorrow' | 'monday';

export interface SchedulePreset {
  readonly id: PresetId;
  readonly at: Date;
}

/** `YYYY-MM-DD` a number of calendar days on: a calendar's arithmetic, so a day with 23 or 25 hours is still one. */
export const addDays = (isoDay: string, days: number): string => {
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

/** A time in words: today or tomorrow with the hour, any other day by its date. */
export const describeWhen = (at: Date, now: Date, format: Formatters, t: Translate): string => {
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
