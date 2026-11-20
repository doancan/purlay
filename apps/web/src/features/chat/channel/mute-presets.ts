/**
 * The whiles a channel can be muted for (D-329), and the instant each ends at — pure functions of the clock and the
 * viewer's time zone, which `Formatters` carries (`i18n/format.ts`), as the reminder presets are.
 *
 * "Until tomorrow" is Deep Work's morning (D-124): nine on the viewer's wall clock the next day, or this morning
 * when it is chosen in the small hours. Every end is kept inside the server's bound — Deep Work's
 * `DEEP_WORK_MAX_HOURS` — less a margin, so a clock here a little ahead of the server's does not turn "24 hours"
 * into a refusal.
 */
import { DEEP_WORK_MAX_HOURS } from '@purlay/types';
import type { Formatters } from '../../../i18n/format';
import { dayAfter, morningOf } from '../reminders/presets';

export const MUTE_CHOICES = ['15m', '1h', '8h', '24h', 'tomorrow'] as const;
export type MuteChoice = (typeof MUTE_CHOICES)[number];

type Zone = Pick<Formatters, 'isoDay' | 'inputValue' | 'instantOf'>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SPANS = {
  '15m': 15 * MINUTE_MS,
  '1h': HOUR_MS,
  '8h': 8 * HOUR_MS,
  '24h': 24 * HOUR_MS,
} as const;

/** Before this hour the night is not over: "until tomorrow" at one in the morning means this morning (D-124). */
const NIGHT_ENDS_HOUR = 5;

/** Kept back from the server's bound, for a clock here a little ahead of the server's. */
const BOUND_MARGIN_MS = MINUTE_MS;

/** The instant a choice made at `now` ends at, as the API's UTC timestamp. */
export const muteEnd = (choice: MuteChoice, now: Date, zone: Zone): string => {
  const bound = now.getTime() + DEEP_WORK_MAX_HOURS * HOUR_MS - BOUND_MARGIN_MS;
  if (choice !== 'tomorrow') {
    return new Date(Math.min(now.getTime() + SPANS[choice], bound)).toISOString();
  }
  const today = zone.isoDay(now);
  const hour = Number(zone.inputValue(now).slice(11, 13));
  const morning = morningOf(hour < NIGHT_ENDS_HOUR ? today : dayAfter(today, 1), zone);
  return new Date(Math.min(new Date(morning).getTime(), bound)).toISOString();
};
