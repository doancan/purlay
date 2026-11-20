/**
 * A person's status line as it reads now (D-330): its emoji and words, and until when — or nothing once its end has
 * passed. The server already answers a line past its end as cleared; this keeps a list read before the end from
 * showing it after, until the list is read again.
 */
import type { Profile } from '@purlay/types';
import type { Formatters } from '../i18n/format';

export interface StatusLine {
  readonly emoji: string | null;
  readonly words: string | null;
  readonly until: string | null;
}

export const statusLineAt = (profile: Profile | undefined, now: number): StatusLine | null => {
  if (profile === undefined) return null;
  const until = profile.statusUntil ?? null;
  if (until !== null && new Date(until).getTime() <= now) return null;
  const emoji = profile.statusEmoji ?? null;
  if (profile.status === null && emoji === null) return null;
  return { emoji, words: profile.status, until };
};

/** An end as the viewer reads it: its clock time on the same day, the whole date and time on another. */
export const untilText = (
  until: string,
  now: number,
  format: Pick<Formatters, 'isoDay' | 'inputValue' | 'absolute'>,
): string =>
  format.isoDay(until) === format.isoDay(new Date(now))
    ? format.inputValue(until).slice(-5)
    : format.absolute(until);
