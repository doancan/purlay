/**
 * An instant a person's own state ends at by itself — Deep Work (D-108), a notification level chosen for a while
 * (D-329): ahead of the server's clock, and no further than a bound, so nothing can be forgotten on. One rule, so
 * the two cannot drift apart on what "ahead" and "at most" mean.
 */
import { HOUR_MS, type Clock } from './clock';
import { AppError } from './errors';

/**
 * The instant `until` names, when it is after now and at most `maxHours` from now; otherwise a refusal of the
 * field by name, which says the window. `what` begins the message: "Deep Work", "A timed level".
 */
export const requireEndAhead = (
  clock: Clock,
  until: string,
  maxHours: number,
  what: string,
): Date => {
  const end = new Date(until);
  const now = clock.now().getTime();
  // A string the contract's pattern lets through can still name no instant (month 13, hour 99): it is
  // refused here, as a bad value, rather than reaching the database as an invalid date.
  if (
    Number.isNaN(end.getTime()) ||
    end.getTime() <= now ||
    end.getTime() > now + maxHours * HOUR_MS
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `${what} ends in the future, at most ${String(maxHours)} hours from now.`,
      details: { fields: { until: `ahead, and at most ${String(maxHours)} hours` } },
    });
  }
  return end;
};
