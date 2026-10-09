import { sql } from 'kysely';
import type { Executor } from './client';

/**
 * Removes sessions that can no longer authenticate anyone: expired, or revoked.
 *
 * **Bounded.** One call deletes at most `batch` rows, so a backlog is worked
 * through in turns that each hold their locks briefly, instead of one statement
 * that deletes a year of sessions at once. It returns how many it removed; zero
 * means nothing is left. The scheduler that calls it is #71; the function and its
 * test live with the table (D-87).
 *
 * The two kinds are found by separate indexed selects rather than one `OR`, so
 * neither turns into a scan of the whole table. The time is an argument: the
 * clock is a dependency (D-46).
 */
export const purgeDeadSessions = async (
  db: Executor,
  now: Date,
  batch: number,
): Promise<number> => {
  if (!Number.isInteger(batch) || batch < 1) {
    throw new Error(`batch must be a positive whole number, not ${String(batch)}`);
  }
  const result = await sql`
    delete from sessions where id in (
      select id from (
        (select id from sessions where revoked_at is not null limit ${batch})
        union all
        (select id from sessions where revoked_at is null and expires_at <= ${now} limit ${batch})
      ) dead
      limit ${batch}
    )`.execute(db);
  return Number(result.numAffectedRows ?? 0n);
};
