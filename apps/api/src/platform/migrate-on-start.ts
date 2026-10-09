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
import {
  createMigrationDatabase,
  migrateToLatest,
  type MigrateOptions,
  type MigrationConnection,
} from '@purlay/db';

/**
 * Opens a connection of its own, the one `bun run db:migrate` uses (D-87), and closes it
 * again. It does not take the application's pool: that pool cancels a statement after
 * 30 s, which would cut off an index build and put the node in a loop of restarts.
 */
export const migrateOnStart = async (
  connection: MigrationConnection,
  directory?: string,
  options: Pick<MigrateOptions, 'onRetry'> = {},
): Promise<readonly string[]> => {
  const database = createMigrationDatabase(connection);
  const { error, results } = await migrateToLatest(database, directory, options).finally(
    async () => {
      await database.destroy();
    },
  );
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
