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
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { migrateToLatest } from './migrator';
import type { DB } from './schema';

class Rollback extends Error {
  constructor() {
    super('rolled back by the test harness');
    this.name = 'Rollback';
  }
}

let shared: Kysely<DB> | undefined;

/** Refuses rather than skipping when there is nothing to connect to. */
const integrationUrl = (): string => {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DATABASE_URL is not set, so these tests would silently prove nothing.\n' +
        'Start the environment and run them with:\n' +
        '  bun run db:up:postgres && bun run test:integration',
    );
  }
  return connectionString;
};

const connect = <T>(connectionString: string, max: number): Kysely<T> =>
  new Kysely<T>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }) });

/** The same server, another database on it. */
const onDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

/** One pool for the run. */
export const integrationDatabase = (): Kysely<DB> => {
  const connectionString = integrationUrl();
  shared ??= connect<DB>(connectionString, 4);
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

export interface ClonedDatabase {
  readonly db: Kysely<DB>;
  /** Closes the pool and drops the database. What `afterAll` must call. */
  readonly drop: () => Promise<void>;
}

/**
 * A database of this test file's own, cloned from a migrated template (D-46).
 *
 * For what one rolled-back transaction cannot do: commit on purpose, or let two
 * connections observe each other. One transaction puts every query on a single
 * connection, which serialises exactly the concurrency such a test exists to see.
 *
 * The template is brought up to date on every call. Migrating an applied
 * template is a no-op; skipping it would let a template from an older run hide a
 * migration added since, and the test would pass against a schema that no longer
 * exists. Cloning needs nothing connected to the template, so its connection is
 * closed before the clone is made.
 */
export const cloneIntegrationDatabase = async (): Promise<ClonedDatabase> => {
  const source = integrationUrl();
  const base = new URL(source).pathname.slice(1);
  const template = `${base}_template`;
  const clone = `${base}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

  const admin = connect<unknown>(onDatabase(source, 'postgres'), 1);
  try {
    const exists = await sql`select 1 from pg_database where datname = ${template}`.execute(admin);
    if (exists.rows.length === 0) await sql`create database ${sql.id(template)}`.execute(admin);

    const templateDb = connect<unknown>(onDatabase(source, template), 1);
    try {
      const { error } = await migrateToLatest(templateDb);
      if (error !== undefined)
        throw new Error('migrating the test template failed', { cause: error });
    } finally {
      await templateDb.destroy();
    }

    await sql`create database ${sql.id(clone)} template ${sql.id(template)}`.execute(admin);
  } finally {
    await admin.destroy();
  }

  const db = connect<DB>(onDatabase(source, clone), 4);
  return {
    db,
    drop: async (): Promise<void> => {
      await db.destroy();
      const dropper = connect<unknown>(onDatabase(source, 'postgres'), 1);
      try {
        await sql`drop database ${sql.id(clone)} with (force)`.execute(dropper);
      } finally {
        await dropper.destroy();
      }
    },
  };
};
