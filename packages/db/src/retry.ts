import pg from 'pg';

/**
 * Trying a migration again when PostgreSQL ended it as the victim of a deadlock (D-86).
 *
 * A migration takes locks a running application also takes, in an order of its own. When the
 * two cross, PostgreSQL ends one transaction with SQLSTATE `40P01`, and under load it is the
 * migrator that is chosen as often as not. The deadlock is nothing the migration did wrong,
 * and the statement that was ended changed nothing, so the right answer is to wait a moment
 * and run it again.
 *
 * Nothing else is retried. A constraint violation, a syntax error and a timeout are
 * properties of the migration or of the data, and running them again only delays the report.
 */
export const isDeadlock = (error: unknown): boolean =>
  error instanceof pg.DatabaseError && error.code === '40P01';

export interface RetryPolicy {
  /** Attempts in all, the first included. */
  readonly attempts: number;
  /** Waits before the second attempt, the third, and so on; the last repeats if it runs out. */
  readonly pausesMilliseconds: readonly number[];
}

export const DEADLOCK_RETRY: RetryPolicy = {
  attempts: 5,
  pausesMilliseconds: [250, 500, 1000, 2000],
};

export interface Retry {
  /** The attempt that failed, from 1. */
  readonly attempt: number;
  readonly error: Error;
  readonly pauseMilliseconds: number;
}

/**
 * Runs `attempt` until it stops being ended by a deadlock, or the policy runs out, in which
 * case the last deadlock is thrown as it was. Each retry is reported before it waits.
 */
export const retryOnDeadlock = async <T>(
  attempt: () => Promise<T>,
  policy: RetryPolicy,
  onRetry: (retry: Retry) => void,
): Promise<T> => {
  for (let number = 1; ; number += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isDeadlock(error) || !(error instanceof Error) || number >= policy.attempts) throw error;
      const pause =
        policy.pausesMilliseconds[Math.min(number, policy.pausesMilliseconds.length) - 1] ?? 0;
      onRetry({ attempt: number, error, pauseMilliseconds: pause });
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
};
