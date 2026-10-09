/**
 * Applying pending migrations when the process starts (#248, D-93).
 *
 * This is the wiring, and deliberately little else. Several nodes started together
 * each call `migrateToLatest`, and what keeps them from interleaving is the
 * migrator's own session advisory lock, polled with `pg_try_advisory_lock` so that a
 * waiting starter holds nothing open (D-86): a starter that waited inside a
 * transaction deadlocked against the running migration's `CREATE INDEX
 * CONCURRENTLY`, which is what this module used to work around with a lock of its
 * own. A second lock here would be a second thing to keep in step with the first, so
 * there is none.
 *
 * What this adds is what the migrator, a library function, cannot decide for a
 * process: it is opt-in, it runs after the listener is open so liveness answers and
 * readiness says 503 while it works, and a failure is an exception the caller turns
 * into an exit — a node that cannot migrate must not keep running as though it could.
 */
import { migrateToLatest, type Executor, type MigrateOptions } from '@purlay/db';

export const migrateOnStart = async (
  database: Executor,
  directory?: string,
  options: Pick<MigrateOptions, 'onRetry'> = {},
): Promise<readonly string[]> => {
  const { error, results } = await migrateToLatest(database, directory, options);
  if (error !== undefined) {
    const failed = (results ?? []).find((result) => result.status === 'Error');
    throw new Error(
      `migrating on start failed${failed === undefined ? '' : ` at ${failed.migrationName}`}`,
      { cause: error },
    );
  }
  return (results ?? [])
    .filter((result) => result.status === 'Success')
    .map((result) => result.migrationName);
};
