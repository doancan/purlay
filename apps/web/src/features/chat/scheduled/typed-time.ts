/**
 * The time typed or picked in the dialog's date and time field, and the rules for it.
 *
 * Kept apart from the presets because only the dialog needs it, and the dialog is loaded when it is first wanted.
 */
import { SCHEDULE_AHEAD_MAX_DAYS } from '@purlay/types';
import type { Formatters } from '../../../i18n/format';
import { addDays } from './presets';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How soon the dialog lets a time be: the server's own floor is five seconds, which a typed minute never reaches. */
const SOONEST_MS = MINUTE_MS;

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
