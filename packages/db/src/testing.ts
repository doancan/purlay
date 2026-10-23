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
        'Start the environment, name its database in .env.test (see .env.test.example) or in the\n' +
        'environment, and run them with:\n' +
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

/**
 * A handle that has never connected and, pointed at a closed port, cannot: for a test that builds
 * something needing an executor and runs no query. The pool is lazy, so nothing is attempted.
 */
export const unconnectedDatabase = (): Kysely<DB> =>
  connect<DB>('postgres://nobody@127.0.0.1:1/none', 1);

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

/**
 * Drops databases the test run created — all at once, on purpose.
 *
 * `DROP DATABASE` makes the server run a checkpoint and wait for it, so that no
 * dirty page of the dropped files is written later. A checkpoint costs what the
 * run has written so far, and on a CI disk after a migration test that is seconds
 * a drop. One after another, a file that made fifteen databases spent more than
 * the 5 s a hook is allowed, and the run failed with "a beforeEach/afterEach hook
 * timed out" (measured: fifteen drops requested fifteen checkpoints). Requests
 * that arrive while one is running are served by it, so dropping together costs
 * about one checkpoint, whatever the number.
 */
export const dropDatabases = async (names: readonly string[]): Promise<void> => {
  if (names.length === 0) return;
  const admin = connect<unknown>(
    onDatabase(integrationUrl(), 'postgres'),
    Math.min(names.length, 8),
  );
  try {
    await Promise.all(
      names.map(async (name) => {
        await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
      }),
    );
  } finally {
    await admin.destroy();
  }
};

export interface ClonedDatabase {
  readonly db: Kysely<DB>;
  /** Where the clone lives — for a test that opens a pool of its own, as a restarted process would. */
  readonly connectionString: string;
  /** Closes the pool and drops the database. What `afterAll` must call. */
  readonly drop: () => Promise<void>;
}

/**
 * Brings the template database into being and up to date, and returns its name.
 *
 * The expensive part of a clone, and the one that must not happen inside a hook: a
 * hook has five seconds, and building the template (creating a database, running
 * every migration, concurrent index builds among them) took 3.3 s on a disk that
 * writes 8 MB/s, against 0.12 s on a laptop. So `bunfig.toml` preloads
 * `testing-preload.ts`, which calls this once per test process before the first
 * test is collected, outside every timer; `cloneIntegrationDatabase` finds it done.
 *
 * It is brought up to date on every process. Migrating an applied template is a
 * no-op; skipping it would let a template from an older run hide a migration added
 * since, and the test would pass against a schema that no longer exists.
 */
export const buildIntegrationTemplate = async (name?: string): Promise<string> => {
  const source = integrationUrl();
  const template = name ?? `${new URL(source).pathname.slice(1)}_template`;
  const admin = connect<unknown>(onDatabase(source, 'postgres'), 1);
  try {
    const exists = await sql`select 1 from pg_database where datname = ${template}`.execute(admin);
    if (exists.rows.length === 0) await sql`create database ${sql.id(template)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  const templateDb = connect<unknown>(onDatabase(source, template), 1);
  try {
    const { error } = await migrateToLatest(templateDb);
    if (error !== undefined)
      throw new Error('migrating the test template failed', { cause: error });
  } finally {
    await templateDb.destroy();
  }
  return template;
};

/**
 * Brings a database up to the latest migration — by default the configured one, the one `withRollback`
 * runs on directly. Until this, only the template was kept current: a database last migrated before a
 * migration was added made every test that used it fail with "relation does not exist", which reads as a
 * defect in what the tests were about. Migrating an up-to-date database is a no-op, so every run does it.
 */
export const migrateIntegrationDatabase = async (connectionString?: string): Promise<void> => {
  const database = connect<unknown>(connectionString ?? integrationUrl(), 1);
  try {
    const { error } = await migrateToLatest(database);
    if (error !== undefined) {
      throw new Error('migrating the test database failed', { cause: error });
    }
  } finally {
    await database.destroy();
  }
};

let prepared: Promise<string> | undefined;

/**
 * Once per process: the first caller builds the template, the rest wait for it. A
 * failure is remembered too, so every file that wanted a clone fails at once with
 * the one reason, instead of each of them trying the database again.
 */
export const prepareIntegrationTemplate = async (): Promise<string> => {
  prepared ??= buildIntegrationTemplate();
  return await prepared;
};

/**
 * What the preload does: prepares the template when a database is configured, and
 * says so when that fails.
 *
 * Without `DATABASE_URL` it does nothing, as `bun run test` is meant to; the
 * integration helpers refuse by themselves when a test asks for a database. With
 * one that does not answer it warns and lets the tests report it, rather than
 * failing a run of unit tests that never wanted a database.
 */
export const prepareTemplateForRun = async (
  prepare: () => Promise<unknown>,
  warn: (message: string) => void,
): Promise<void> => {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') return;
  try {
    await prepare();
  } catch (error) {
    warn(
      `testing-preload: the test template could not be prepared (${error instanceof Error ? error.message : String(error)}); the integration tests will report it\n`,
    );
  }
};

/**
 * A database of this test file's own, cloned from a migrated template (D-46).
 *
 * For what one rolled-back transaction cannot do: commit on purpose, or let two
 * connections observe each other. One transaction puts every query on a single
 * connection, which serialises exactly the concurrency such a test exists to see.
 *
 * Cloning needs nothing connected to the template, and nothing is: the template's
 * connection is closed when it has been migrated.
 */
export const cloneIntegrationDatabase = async (): Promise<ClonedDatabase> => {
  const source = integrationUrl();
  const template = await prepareIntegrationTemplate();
  const clone = `${new URL(source).pathname.slice(1)}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

  const admin = connect<unknown>(onDatabase(source, 'postgres'), 1);
  try {
    await sql`create database ${sql.id(clone)} template ${sql.id(template)}`.execute(admin);
  } finally {
    await admin.destroy();
  }

  const connectionString = onDatabase(source, clone);
  const db = connect<DB>(connectionString, 4);
  return {
    db,
    connectionString,
    drop: async (): Promise<void> => {
      await db.destroy();
      await dropDatabases([clone]);
    },
  };
};
