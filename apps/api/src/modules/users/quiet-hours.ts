/**
 * A person's quiet hours (D-234): a window of the day on chosen days of the week, every week, read on the
 * clock of their profile's time zone. While it holds, what would interrupt them is written and counted
 * as always and held back as Deep Work holds it (`workspaces/deep-work.ts#inDeepWork`, D-15).
 *
 * The window needs a time zone to be read in, and the profile's is the person's one fact about it:
 * setting quiet hours without one is refused on `quietHours`, never guessed from the server's clock.
 */
import type { Executor } from '@purlay/db';
import {
  isQuietAt,
  type QuietHours,
  type QuietHoursSetting,
  type SetQuietHoursRequest,
} from '@purlay/types';
import { AppError } from '../../platform/errors';

/** The days as stored: a bit each, Sunday 1 to Saturday 64 (0066). */
const toBits = (days: readonly number[]): number =>
  days.reduce((bits, day) => bits | (1 << day), 0);
const fromBits = (bits: number): number[] =>
  [0, 1, 2, 3, 4, 5, 6].filter((day) => (bits & (1 << day)) !== 0);

interface QuietColumns {
  readonly time_zone: string | null;
  readonly quiet_from: number | null;
  readonly quiet_to: number | null;
  readonly quiet_days: number | null;
}

const windowOf = (row: QuietColumns): QuietHours | null =>
  row.quiet_from === null || row.quiet_to === null || row.quiet_days === null
    ? null
    : { from: row.quiet_from, to: row.quiet_to, days: fromBits(row.quiet_days) };

/** Whether the person whose columns these are is in their quiet hours at `now`. */
export const isQuietNow = (row: QuietColumns, now: Date): boolean => {
  const window = windowOf(row);
  return window !== null && row.time_zone !== null && isQuietAt(window, row.time_zone, now);
};

const settingOf = (row: QuietColumns): QuietHoursSetting => ({
  quietHours: windowOf(row),
  timeZone: row.time_zone,
});

const columnsOf = async (executor: Executor, userId: string): Promise<QuietColumns> =>
  await executor
    .selectFrom('users')
    .select(['time_zone', 'quiet_from', 'quiet_to', 'quiet_days'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

export const readQuietHours = async (
  executor: Executor,
  userId: string,
): Promise<QuietHoursSetting> => settingOf(await columnsOf(executor, userId));

/**
 * Sets the window, or clears it with `null`. Two equal ends are no window and are refused, as is a window
 * with no time zone on the profile to read it in.
 */
export const setQuietHours = async (
  executor: Executor,
  userId: string,
  input: SetQuietHoursRequest,
): Promise<QuietHoursSetting> => {
  const { quietHours } = input;
  if (quietHours !== null) {
    const refused = (why: string): AppError =>
      new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Those quiet hours cannot be kept.',
        details: { fields: { quietHours: why } },
      });
    if (quietHours.from === quietHours.to) throw refused('starts and ends at different times');
    if ((await columnsOf(executor, userId)).time_zone === null) {
      throw refused('needs a time zone on your profile');
    }
  }
  const row = await executor
    .updateTable('users')
    .set({
      quiet_from: quietHours?.from ?? null,
      quiet_to: quietHours?.to ?? null,
      quiet_days: quietHours === null ? null : toBits(quietHours.days),
    })
    .where('id', '=', userId)
    .returning(['time_zone', 'quiet_from', 'quiet_to', 'quiet_days'])
    .executeTakeFirstOrThrow();
  return settingOf(row);
};
