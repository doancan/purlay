/**
 * The times "Send later" offers, and how a time is said.
 *
 * Every time here is a wall-clock time in the viewer's zone, turned into an instant by the formatters
 * (`instantOf`), which know the zone's clock changes. The calendar helpers are the reminders' (the same
 * viewer's wall clock); what is Send later's own is which times it offers. Pure: the caller passes `now`.
 */
import type { Formatters } from '../../../i18n/format';
import type { Translate } from '../../../i18n/types';
import { dayAfter, HOUR_MS, weekdayOf } from '../../../lib/time';
import { morningOf, type Zone } from '../reminders/presets';

const SUNDAY = 0;
const MONDAY = 1;
const DAYS_IN_WEEK = 7;

export type PresetId = 'hour' | 'tomorrow' | 'monday';

export interface SchedulePreset {
  readonly id: PresetId;
  readonly at: Date;
}

/**
 * An hour from now, tomorrow morning and the next Monday morning. Monday is left out on a Sunday,
 * when it is tomorrow, and on a Monday, when "Monday" would read as today.
 */
export const schedulePresets = (now: Date, zone: Zone): readonly SchedulePreset[] => {
  const today = zone.isoDay(now);
  const presets: SchedulePreset[] = [
    { id: 'hour', at: new Date(now.getTime() + HOUR_MS) },
    { id: 'tomorrow', at: new Date(morningOf(dayAfter(today, 1), zone)) },
  ];
  const weekday = weekdayOf(today);
  if (weekday !== SUNDAY && weekday !== MONDAY) {
    const untilMonday = DAYS_IN_WEEK + MONDAY - weekday;
    presets.push({ id: 'monday', at: new Date(morningOf(dayAfter(today, untilMonday), zone)) });
  }
  return presets;
};

/** A time in words: today or tomorrow with the hour, any other day by its date. */
export const describeWhen = (at: Date, now: Date, format: Formatters, t: Translate): string => {
  const time = format.inputValue(at).slice(-5);
  const day = format.isoDay(at);
  const today = format.isoDay(now);
  if (day === today) return t('scheduled.when.today', { time });
  if (day === dayAfter(today, 1)) return t('scheduled.when.tomorrow', { time });
  const named = format.day(at, now, {
    today: t('message.today'),
    yesterday: t('message.yesterday'),
  });
  return t('scheduled.when.on', { day: named, time });
};
