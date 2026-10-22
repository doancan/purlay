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
  migrationHistoryProblem,
  pendingMigrations,
  type Executor,
  type MigrateOptions,
  type MigrationConnection,
} from '@purlay/db';
import type { Logger } from './logging';

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

/** How often a node that does not migrate looks again for the migrations it waits on. */
const MIGRATED_POLL_MS = 2_000;

/**
 * For a node that does not migrate on start: resolves once the database answers and every migration
 * this code ships is applied — by an operator's `bun run db:migrate`, or by another node — so what the
 * process reads next (the server's settings, D-179 §6) is there to read. Until then readiness says 503
 * and why (`readiness.ts`); this says once, at `warn`, for each kind of reason it waits on — the
 * database not answering, the history not matching, migrations not applied — rather than once a poll.
 * Never gives up: a node started before its database is a node that should start when it comes.
 */
export const untilMigrated = async (
  database: Executor,
  log: Logger,
  pollMs: number = MIGRATED_POLL_MS,
): Promise<void> => {
  let said: string | undefined;
  for (;;) {
    let kind: string | undefined;
    let reason: string | undefined;
    try {
      const history = await migrationHistoryProblem(database);
      const pending = history === undefined ? await pendingMigrations(database) : [];
      if (history !== undefined) [kind, reason] = ['history', history];
      else if (pending.length > 0) {
        [kind, reason] = ['pending', `migrations not applied: ${pending.join(', ')}`];
      }
    } catch (error) {
      kind = 'unreachable';
      reason = `the database did not answer: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (kind === undefined) return;
    if (kind !== said) {
      log.warn('waiting for the migrations before reading the settings', { reason });
      said = kind;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};
