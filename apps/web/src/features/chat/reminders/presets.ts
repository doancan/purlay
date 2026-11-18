/**
 * The times "Remind me…" offers, and the check on a time a person types — pure functions of the clock
 * and the viewer's time zone, which `Formatters` carries (`i18n/format.ts`). "Tomorrow at 09:00" is the
 * viewer's wall clock, so a clock change between now and then moves the hours, not the 09:00.
 */
import { SCHEDULE_AHEAD_MAX_DAYS } from '@purlay/types';
import type { Formatters } from '../../../i18n/format';

type Zone = Pick<Formatters, 'isoDay' | 'inputValue' | 'instantOf'>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MORNING = '09:00';
const MONDAY = 1;

/** How far ahead a reminder may be asked for (`API.md`: the scheduled messages' bounds). */
const AHEAD_MIN_MS = MINUTE_MS;
const AHEAD_MAX_MS = SCHEDULE_AHEAD_MAX_DAYS * DAY_MS - MINUTE_MS;

export type PresetId = 'in20m' | 'in1h' | 'in3h' | 'tomorrow' | 'monday';

export interface Preset {
  readonly id: PresetId;
  /** The instant, as the API's UTC timestamp. */
  readonly at: string;
}

/** The calendar day `days` after `day` (`YYYY-MM-DD`): a day of the calendar, never 24 hours. */
const dayAfter = (day: string, days: number): string => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const weekdayOf = (day: string): number => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The wall clock `HH:mm` on a calendar day, as an instant; the day is always real, so never null. */
const morningOf = (day: string, zone: Zone): string => {
  const at = zone.instantOf(`${day}T${MORNING}`);
  if (at === null) throw new Error(`no ${MORNING} on ${day}`);
  return at;
};

export const reminderPresets = (now: Date, zone: Zone): readonly Preset[] => {
  const after = (ms: number): string => new Date(now.getTime() + ms).toISOString();
  const today = zone.isoDay(now);
  // Sunday is 0: the Monday after it is one day on, and after a Monday itself, seven.
  const toMonday = (MONDAY + 7 - weekdayOf(today)) % 7 || 7;
  return [
    { id: 'in20m', at: after(20 * MINUTE_MS) },
    { id: 'in1h', at: after(HOUR_MS) },
    { id: 'in3h', at: after(3 * HOUR_MS) },
    { id: 'tomorrow', at: morningOf(dayAfter(today, 1), zone) },
    { id: 'monday', at: morningOf(dayAfter(today, toMonday), zone) },
  ];
};

/**
 * What a date-and-time input may hold: a minute ahead, rounded up to a whole minute so the first
 * choice is far enough, and a year at most, rounded down so the last one is not too far.
 */
export const reminderBounds = (
  now: Date,
  zone: Pick<Formatters, 'inputValue'>,
): { readonly min: string; readonly max: string } => ({
  min: zone.inputValue(new Date(Math.ceil((now.getTime() + AHEAD_MIN_MS) / MINUTE_MS) * MINUTE_MS)),
  max: zone.inputValue(new Date(now.getTime() + AHEAD_MAX_MS)),
});

export type ReminderCheck =
  | { readonly ok: true; readonly at: string }
  | { readonly ok: false; readonly reason: 'missing' | 'past' | 'far' };

/** A typed time as the instant it names, or why it will not do — said on the field, not by the server. */
export const validateReminder = (typed: string, now: Date, zone: Zone): ReminderCheck => {
  const at = zone.instantOf(typed);
  if (at === null) return { ok: false, reason: 'missing' };
  const ahead = new Date(at).getTime() - now.getTime();
  if (ahead < AHEAD_MIN_MS) return { ok: false, reason: 'past' };
  if (ahead > AHEAD_MAX_MS) return { ok: false, reason: 'far' };
  return { ok: true, at };
};
