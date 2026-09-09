/**
 * The integration test harness.
 *
 * Every test runs inside a transaction that is rolled back, so nothing is
 * truncated and nothing is re-seeded and two tests that write the same row pass
 * in either order (D-46).
 *
 * **There is no silent skip.** A suite that quietly runs zero integration tests
 * looks exactly like one where everything passed, and a check that reports
 * success for the wrong reason is the failure this project guards against
 * everywhere else (`CONTRIBUTING.md` §6.4). If the database is not there, the
 * helper refuses; `bun run test` excludes these files, and `bun run
 * test:integration` is the command that runs them.
 */
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

class Rollback extends Error {
  constructor() {
    super('rolled back by the test harness');
    this.name = 'Rollback';
  }
}

let shared: Kysely<DB> | undefined;

/** One pool for the run. Refuses rather than skipping when there is nothing to connect to. */
export const integrationDatabase = (): Kysely<DB> => {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DATABASE_URL is not set, so these tests would silently prove nothing.\n' +
        'Start the environment and run them with:\n' +
        '  bun run db:up && bun run test:integration',
    );
  }
  shared ??= new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 4 }) }),
  });
  return shared;
};

/**
 * Runs the body in a transaction and rolls it back, whatever happened.
 *
 * The body receives a `Transaction`, which is what a service would receive as
 * its executor — so a service that reaches for a database handle of its own
 * cannot be tested this way, which is the point (D-46).
 */
export const withRollback = async (
  body: (executor: Transaction<DB>) => Promise<void>,
): Promise<void> => {
  const db = integrationDatabase();
  try {
    await db.transaction().execute(async (trx) => {
      await body(trx);
      // Kysely commits when the callback resolves. The only way to keep the
      // transaction from committing is to leave it by throwing.
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
};

/**
 * Closes the shared pool. Every integration file calls this in `afterAll`.
 *
 * That is safe because `integrationDatabase` reopens on demand: the runner works
 * through the files one at a time, so a file that closes the pool costs the next
 * one a reconnection and nothing else. Naming one file as "the last" would be a
 * fact nothing enforces, wrong the moment a file is added.
 */
export const closeIntegrationDatabase = async (): Promise<void> => {
  if (shared !== undefined) {
    await shared.destroy();
    shared = undefined;
  }
};
