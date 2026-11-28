/**
 * When a status line clears itself (D-330): the choices the profile offers, and the instant each comes to — pure
 * functions of the clock and the viewer's time zone, which `Formatters` carries (`i18n/format.ts`), so "today" and
 * "this week" end at the viewer's own midnight, a clock change between included.
 *
 * Every end is kept a minute inside the server's bound, `STATUS_UNTIL_MAX_DAYS`, for a clock here a little ahead of
 * the server's.
 */
import { STATUS_UNTIL_MAX_DAYS } from '@purlay/types';
import type { Formatters } from '../../../i18n/format';
import { dayAfter, HOUR_MS, MINUTE_MS, weekdayOf } from '../../../lib/time';

export const STATUS_CLEARS = ['never', '30m', '1h', '4h', 'today', 'week'] as const;
export type StatusClear = (typeof STATUS_CLEARS)[number];

type Zone = Pick<Formatters, 'isoDay' | 'dayStart'>;

const SPANS = { '30m': 30 * MINUTE_MS, '1h': HOUR_MS, '4h': 4 * HOUR_MS } as const;
const MONDAY = 1;

/**
 * The instant a choice made at `now` clears the line at, as the API's UTC timestamp; null for "don't clear".
 * "Today" ends at the viewer's next midnight; "this week" at the midnight that begins next Monday.
 */
export const statusEnd = (choice: StatusClear, now: Date, zone: Zone): string | null => {
  if (choice === 'never') return null;
  const bound = now.getTime() + STATUS_UNTIL_MAX_DAYS * 24 * HOUR_MS - MINUTE_MS;
  const today = zone.isoDay(now);
  const end =
    choice === 'today'
      ? new Date(zone.dayStart(dayAfter(today, 1))).getTime()
      : choice === 'week'
        ? new Date(
            zone.dayStart(dayAfter(today, (MONDAY + 7 - weekdayOf(today)) % 7 || 7)),
          ).getTime()
        : now.getTime() + SPANS[choice];
  return new Date(Math.min(end, bound)).toISOString();
};
