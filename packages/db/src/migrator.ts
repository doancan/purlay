import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely, type QueryExecutorProvider } from 'kysely';
import { splitStatements } from './statements';

export const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Migrations are `.sql` files, numbered and applied in order.
 *
 * SQL rather than a query-builder script because the schema *is* SQL: partial
 * indexes, CHECK constraints and explicit collations are where half this
 * schema's correctness lives, and expressing them through a builder would put a
 * translation layer between the document and the database. (`SCHEMA.md`)
 *
 * **There are no down migrations, deliberately.** A rollback script runs once,
 * in an emergency, having never been executed successfully — which is the worst
 * possible moment to discover it is wrong. A bad migration is fixed by another
 * migration, and data loss is recovered from point-in-time recovery (D-44).
 * Append-only means the history is the truth. (`CONTRIBUTING.md` §1.6)
 *
 * **Each migration is one transaction, unless its file says otherwise (D-86).** A
 * file whose leading comments hold `-- purlay: no-transaction` runs statement by
 * statement, outside one. That is the only way to `CREATE INDEX CONCURRENTLY`,
 * and the only way a `VALIDATE CONSTRAINT` does not keep the lock of the `ADD
 * CONSTRAINT` before it for the whole scan. Such a file must be safe to run
 * again: a crash between its statements leaves the migration unrecorded, so the
 * next start runs it from the top.
 *
 * **Each applied migration records the SHA-256 of its file**, and a file that no
 * longer matches is a failure before anything is run. A migration applied before
 * checksums existed has none recorded; it is adopted once, with the checksum of
 * the file as it stands, which is trust on first use and is said so in D-86.
 */

/** Held for the whole run, so concurrent starters take turns. Distinct from Kysely's own key. */
const MIGRATION_LOCK_KEY = sql.lit(1886351481);
/** How long a starter waits for another to finish before giving up. */
const LOCK_WAIT_MILLISECONDS = 120_000;

const TABLE = 'kysely_migration';
const OPT_OUT = /^--\s*purlay:\s*no-transaction\s*$/;

export interface MigrationFile {
  readonly name: string;
  readonly text: string;
  readonly checksum: string;
  /** False when the file opts out of the wrapping transaction. */
  readonly transactional: boolean;
}

export interface MigrationResult {
  readonly migrationName: string;
  readonly status: 'Success' | 'Error' | 'NotExecuted';
}

export interface MigrationResultSet {
  readonly error?: unknown;
  readonly results?: readonly MigrationResult[];
}

/** The opt-out is read from the leading comment block only, never from the middle of a statement. */
const isTransactional = (text: string): boolean => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('--')) return true;
    if (OPT_OUT.test(trimmed)) return false;
  }
  return true;
};

export const readMigrationFiles = async (
  directory = MIGRATIONS_DIRECTORY,
): Promise<readonly MigrationFile[]> => {
  const names = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
  return await Promise.all(
    names.map(async (file): Promise<MigrationFile> => {
      const text = await readFile(join(directory, file), 'utf8');
      return {
        name: file.replace(/\.sql$/, ''),
        text,
        checksum: createHash('sha256').update(text).digest('hex'),
        transactional: isTransactional(text),
      };
    }),
  );
};

interface Recorded {
  readonly name: string;
  readonly checksum: string | null;
}

const readRecorded = async (db: QueryExecutorProvider): Promise<Recorded[]> => {
  const { rows } = await sql<Recorded>`
    select name, checksum from ${sql.table(TABLE)} order by timestamp, name`.execute(db);
  return rows;
};

/** Refuses a history the files no longer describe. Runs before anything is applied. */
const verify = (files: readonly MigrationFile[], recorded: readonly Recorded[]): Recorded[] => {
  const adopt: Recorded[] = [];
  recorded.forEach((row, index) => {
    const file = files.find((f) => f.name === row.name);
    if (file === undefined) {
      throw new Error(`corrupted migrations: previously applied migration ${row.name} is missing`);
    }
    if (files[index]?.name !== row.name) {
      throw new Error(
        `corrupted migrations: expected applied migration ${row.name} at position ${String(index + 1)}, ` +
          `found ${files[index]?.name ?? 'nothing'}. A new migration must sort after the last applied one.`,
      );
    }
    if (row.checksum === null) adopt.push(row);
    else if (row.checksum !== file.checksum) {
      throw new Error(
        `migration ${row.name} was edited after it was applied: recorded checksum ` +
          `${row.checksum.slice(0, 12)}…, file is ${file.checksum.slice(0, 12)}…. ` +
          'A migration that has run is never edited; write a new one.',
      );
    }
  });
  return adopt;
};

const apply = async <T>(conn: Kysely<T>, file: MigrationFile): Promise<void> => {
  const record = async (db: QueryExecutorProvider): Promise<void> => {
    await sql`
      insert into ${sql.table(TABLE)} (name, timestamp, checksum)
      values (${file.name}, to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              ${file.checksum})`.execute(db);
  };
  if (file.transactional) {
    await conn.transaction().execute(async (trx) => {
      await sql.raw(file.text).execute(trx);
      await record(trx);
    });
    return;
  }
  for (const statement of splitStatements(file.text)) await sql.raw(statement).execute(conn);
  await record(conn);
};

/** Idempotent: applying an already-applied migration is a no-op. */
export const migrateToLatest = async <T>(
  db: Kysely<T>,
  directory = MIGRATIONS_DIRECTORY,
): Promise<MigrationResultSet> => {
  const results: MigrationResult[] = [];
  try {
    const files = await readMigrationFiles(directory);
    await db.connection().execute(async (conn) => {
      await sql`select set_config('lock_timeout', ${String(LOCK_WAIT_MILLISECONDS)}, false)`.execute(
        conn,
      );
      await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`.execute(conn);
      try {
        // Back to unbounded, so a long index build is not cut off by the wait for the lock.
        await sql`reset lock_timeout`.execute(conn);
        await sql`
          create table if not exists ${sql.table(TABLE)} (
            name varchar(255) primary key, timestamp varchar(255) not null)`.execute(conn);
        await sql`alter table ${sql.table(TABLE)} add column if not exists checksum text`.execute(
          conn,
        );

        const recorded = await readRecorded(conn);
        for (const row of verify(files, recorded)) {
          const file = files.find((f) => f.name === row.name);
          await sql`update ${sql.table(TABLE)} set checksum = ${file?.checksum ?? null}
            where name = ${row.name}`.execute(conn);
        }

        const done = new Set(recorded.map((row) => row.name));
        for (const file of files.filter((f) => !done.has(f.name))) {
          try {
            await apply(conn, file);
          } catch (error) {
            results.push({ migrationName: file.name, status: 'Error' });
            throw error;
          }
          results.push({ migrationName: file.name, status: 'Success' });
        }
      } finally {
        await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.execute(conn);
      }
    });
    return { results };
  } catch (error) {
    return { error, results };
  }
};

/**
 * Why the history of this database no longer matches the files, or `undefined`.
 *
 * The check the migrator runs before it applies anything, asked read-only: an applied
 * migration whose file was edited, a file that has gone, or a new migration that sorts
 * before an applied one. Readiness uses it, so a process whose code and schema have
 * parted says so instead of serving until a query finds out (D-86).
 */
export const migrationHistoryProblem = async (
  db: QueryExecutorProvider,
  directory = MIGRATIONS_DIRECTORY,
): Promise<string | undefined> => {
  const present = await sql<{ table: boolean; checksum: boolean }>`
    select to_regclass(${TABLE}) is not null as "table",
           exists (select 1 from information_schema.columns
                   where table_schema = current_schema() and table_name = ${TABLE}
                     and column_name = 'checksum') as checksum`.execute(db);
  if (present.rows[0]?.table !== true) return undefined;
  const files = await readMigrationFiles(directory);
  // A database migrated before checksums existed has no column: every row is unchecked.
  const recorded = present.rows[0].checksum
    ? await readRecorded(db)
    : (
        await sql<Recorded>`
            select name, null as checksum from ${sql.table(TABLE)} order by timestamp, name`.execute(
          db,
        )
      ).rows;
  try {
    verify(files, recorded);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * The migrations in the directory this database has not applied, by name.
 *
 * What readiness asks before a process takes traffic: code ahead of its schema
 * fails on the first query that touches what is missing (#108).
 */
export const pendingMigrations = async (
  db: QueryExecutorProvider,
  directory = MIGRATIONS_DIRECTORY,
): Promise<readonly string[]> => {
  const files = await readMigrationFiles(directory);
  const exists = await sql<{ present: boolean }>`
    select to_regclass(${TABLE}) is not null as present`.execute(db);
  if (exists.rows[0]?.present !== true) return files.map((f) => f.name);
  const { rows } = await sql<{ name: string }>`select name from ${sql.table(TABLE)}`.execute(db);
  const done = new Set(rows.map((row) => row.name));
  return files.filter((f) => !done.has(f.name)).map((f) => f.name);
};
