import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely, type QueryExecutorProvider } from 'kysely';
import pg from 'pg';
import { ModulesSettingError, parseModulesSetting, unmetRequirements } from './modules-setting';
import { DEADLOCK_RETRY, retryOnDeadlock, type Retry, type RetryPolicy } from './retry';
import { executableText, splitStatements } from './statements';

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
/** Between two attempts at the lock: short at first, since most waits are a few milliseconds. */
const LOCK_POLL_FIRST_MILLISECONDS = 25;
const LOCK_POLL_MAX_MILLISECONDS = 500;

/**
 * How long a transactional migration waits for any one lock, unless its file says otherwise (D-86, amended). An
 * `ALTER TABLE` waits for every transaction already using the table, and while it waits every later reader and
 * writer of the table waits behind it, so an unbounded wait is an outage for as long as the one long
 * transaction runs. It bounds the wait to get a lock, never how long a granted lock is held: a backfill is
 * not cut short. The same ten seconds the files that leave their transaction set for themselves.
 */
const LOCK_TIMEOUT_MILLISECONDS = 10_000;
/** SQLSTATE `lock_not_available`: what `lock_timeout` ends a statement with. */
const LOCK_NOT_AVAILABLE = '55P03';

const TABLE = 'kysely_migration';
const OPT_OUT = /^--\s*purlay:\s*no-transaction\s*$/;

export interface MigrationFile {
  readonly name: string;
  readonly text: string;
  readonly checksum: string;
  /** False when the file opts out of the wrapping transaction. */
  readonly transactional: boolean;
}

/**
 * A module's own ordered set of migrations (D-250). Its files live in a directory of their own and are
 * recorded as `<id>/<file>`, so they never collide with the core's, whose rows keep the bare names they have
 * always had. Order and checksum are checked within a set, never across sets: a module that was off for
 * three releases opens on the fourth.
 */
export interface MigrationSet {
  readonly id: string;
  readonly directory: string;
}

const SET_ID = /^[a-z][a-z0-9-]*$/;

/**
 * The sets of the modules this build carries (D-250), one directory each under `migrations/`, applied after the
 * core's and recorded as `<module>/<file>`. A process applies the ones its `MODULES` names (`setsNamedBy`, `MODULES.md` §3).
 */
export const PRODUCT_MIGRATION_SETS = [
  { id: 'chat', directory: join(MIGRATIONS_DIRECTORY, 'chat') },
  { id: 'issues', directory: join(MIGRATIONS_DIRECTORY, 'issues') },
] as const satisfies readonly MigrationSet[];

/**
 * Modules of the build that keep no tables of their own, so have no set. Empty today: a module that has a set is
 * a module id by being in `PRODUCT_MIGRATION_SETS`, and needs nothing here.
 */
const MODULES_WITHOUT_A_SET: readonly string[] = [];

/**
 * The ids of the modules this build carries: every set's id, and the modules that have none. A module that keeps
 * no tables of its own is still a module a `MODULES` setting may name, so this list is the build's, not
 * `PRODUCT_MIGRATION_SETS`'s. The DB package cannot import the API's manifests (dependency direction), so the
 * agreement with them is held by a test, not derived: `module-setting-pair.test.ts` fails by id when the manifests
 * and this list differ.
 */
export const PRODUCT_MODULE_IDS: readonly string[] = [
  ...PRODUCT_MIGRATION_SETS.map((set) => set.id),
  ...MODULES_WITHOUT_A_SET,
];

/**
 * What each module of the build requires of another, by id, as its manifest says (`requires`). Like
 * `PRODUCT_MODULE_IDS` it is kept here because the DB package cannot import the API's manifests, and
 * `module-setting-pair.test.ts` fails when the two differ. It is what lets `db:migrate` refuse a selection the API
 * would refuse for a missing requirement.
 */
export const PRODUCT_MODULE_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  chat: [],
  issues: [],
};

/**
 * The sets a `MODULES` setting names, for the command that migrates before the API starts: unset or blank is every
 * set this build carries, `none` the core alone, otherwise the ones listed. The setting is read by
 * `parseModulesSetting`, the reading the API boots on too, so what this command refuses the API refuses and the
 * other way round, a module whose requirement is not named included (`unmetRequirements`, over `requires`).
 * Throws `ModulesSettingError` naming every problem.
 */
export const setsNamedBy = (
  setting: string | undefined,
  requires: Readonly<Record<string, readonly string[]>> = PRODUCT_MODULE_REQUIRES,
): readonly MigrationSet[] => {
  const parsed = parseModulesSetting(setting, PRODUCT_MODULE_IDS);
  if (parsed.kind === 'all') return PRODUCT_MIGRATION_SETS;
  if (parsed.kind === 'none') return [];
  const unmet = unmetRequirements(parsed.ids, requires);
  if (unmet.length > 0) throw new ModulesSettingError(unmet);
  return PRODUCT_MIGRATION_SETS.filter((set) => parsed.ids.includes(set.id));
};

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
  prefix = '',
): Promise<readonly MigrationFile[]> => {
  const names = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
  return await Promise.all(
    names.map(async (file): Promise<MigrationFile> => {
      const text = await readFile(join(directory, file), 'utf8');
      return {
        name: `${prefix}${file.replace(/\.sql$/, '')}`,
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

/** The files of the core's directory and of each module's set, each set apart from the others. */
interface LoadedSet {
  /** `''` for the core, `<id>/` for a module: the start of every name the set records. */
  readonly prefix: string;
  readonly files: readonly MigrationFile[];
}

const loadSets = async (
  directory: string,
  modules: readonly MigrationSet[],
): Promise<readonly LoadedSet[]> => {
  const seen = new Set<string>();
  for (const { id } of modules) {
    if (!SET_ID.test(id)) throw new Error(`"${id}" is not a migration set id`);
    if (seen.has(id)) throw new Error(`the migration set "${id}" is given twice`);
    seen.add(id);
  }
  return [
    { prefix: '', files: await readMigrationFiles(directory) },
    ...(await Promise.all(
      modules.map(async ({ id, directory: dir }): Promise<LoadedSet> => ({
        prefix: `${id}/`,
        files: await readMigrationFiles(dir, `${id}/`),
      })),
    )),
  ];
};

/** What a database has recorded for the sets of this run, and what it has for sets that are not in it. */
interface Split {
  readonly byPrefix: ReadonlyMap<string, readonly Recorded[]>;
  /** Rows of a module this run does not carry: not an error, a module that is off. */
  readonly dormant: readonly Recorded[];
}

const split = (sets: readonly LoadedSet[], recorded: readonly Recorded[]): Split => {
  const byPrefix = new Map<string, Recorded[]>(sets.map((set) => [set.prefix, []]));
  const dormant: Recorded[] = [];
  for (const row of recorded) {
    const slash = row.name.indexOf('/');
    const prefix = slash === -1 ? '' : row.name.slice(0, slash + 1);
    const rows = byPrefix.get(prefix);
    if (rows === undefined) dormant.push(row);
    else rows.push(row);
  }
  return { byPrefix, dormant };
};

/** Every set checked against its own rows: the rows to adopt, and the rows of the sets that are off. */
const verifySets = (
  sets: readonly LoadedSet[],
  recorded: readonly Recorded[],
  edits: Readonly<Record<string, CommentOnlyEdit>> | undefined,
): { readonly adopt: readonly Recorded[]; readonly dormant: readonly Recorded[] } => {
  const { byPrefix, dormant } = split(sets, recorded);
  const adopt = sets.flatMap((set) => verify(set.files, byPrefix.get(set.prefix) ?? [], edits));
  return { adopt, dormant };
};

/**
 * A correction to the comments of a migration that had already been applied, and nothing else.
 *
 * The files are checksummed whole, so a corrected comment looks exactly like an edited
 * statement, and every database that applied the migration would refuse to start. The one
 * way through is explicit and checkable, and costs a line here for each use: the checksum
 * the databases recorded (`previous`), and the checksum of what the file does, comments
 * stripped and whitespace collapsed (`code`). The edit is accepted only when the database
 * recorded `previous` and the file's code still hashes to `code`, so an edit that changed a
 * statement is refused as before, whatever else it did to the comments. The new checksum is
 * recorded on the next run and the entry stays as history (D-86).
 */
export interface CommentOnlyEdit {
  readonly previous: string;
  readonly code: string;
}

export const COMMENT_ONLY_EDITS: Readonly<Record<string, CommentOnlyEdit>> = {
  // The header said the lock was held "for an instant"; it is held for as long as it takes to
  // get it, which under load includes a deadlock the migrator now retries (D-86).
  '0010_tenant_integrity': {
    previous: '56ad2d20c68a5e5982567a558033052536c3e01f70a5b30881cd5c21e867338b',
    code: '9d370b8dd116a93e90e8e03a3869c78f3ed4ba88dcae0f08a0598d4f06695ed4',
  },
};

export const codeChecksum = (text: string): string =>
  createHash('sha256').update(executableText(text)).digest('hex');

/** Refuses a history the files no longer describe. Runs before anything is applied. */
const verify = (
  files: readonly MigrationFile[],
  recorded: readonly Recorded[],
  edits: Readonly<Record<string, CommentOnlyEdit>> = COMMENT_ONLY_EDITS,
): Recorded[] => {
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
    const edit = edits[row.name];
    if (row.checksum === null) adopt.push(row);
    else if (
      row.checksum !== file.checksum &&
      edit?.previous === row.checksum &&
      codeChecksum(file.text) === edit.code
    ) {
      adopt.push(row);
    } else if (row.checksum !== file.checksum) {
      throw new Error(
        `migration ${row.name} was edited after it was applied: recorded checksum ` +
          `${row.checksum.slice(0, 12)}…, file is ${file.checksum.slice(0, 12)}…. ` +
          'A migration that has run is never edited; write a new one.',
      );
    }
  });
  return adopt;
};

const isLockTimeout = (error: unknown): boolean =>
  error instanceof pg.DatabaseError && error.code === LOCK_NOT_AVAILABLE;

const apply = async <T>(
  conn: Kysely<T>,
  file: MigrationFile,
  lockTimeoutMilliseconds: number,
): Promise<void> => {
  const record = async (db: QueryExecutorProvider): Promise<void> => {
    await sql`
      insert into ${sql.table(TABLE)} (name, timestamp, checksum)
      values (${file.name}, to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              ${file.checksum})`.execute(db);
  };
  if (file.transactional) {
    await conn.transaction().execute(async (trx) => {
      // Only this transaction's, so nothing outlives it on the connection. A file that needs a
      // different wait says so itself with `SET LOCAL lock_timeout`, which comes after this.
      await sql`select set_config('lock_timeout', ${String(lockTimeoutMilliseconds)}, true)`.execute(
        trx,
      );
      await sql.raw(file.text).execute(trx);
      await record(trx);
    });
    return;
  }
  for (const statement of splitStatements(file.text)) await sql.raw(statement).execute(conn);
  await record(conn);
};

/** A migration that waited too long for a lock fails with what an operator does about it. */
const explainLockTimeout = (file: MigrationFile, error: unknown): unknown => {
  if (!isLockTimeout(error)) return error;
  return new Error(
    `migration ${file.name} could not get a lock it needs in time: another transaction is using a table it ` +
      'changes, and waiting any longer would hold up everything else that uses that table. Nothing it ' +
      'did is recorded and it runs again from its top at the next start. Find the long transaction ' +
      '(pg_stat_activity, state and xact_start; pg_locks, granted = false), let it finish or end it, ' +
      'and migrate again (D-86).',
    { cause: error },
  );
};

/**
 * Takes the migration lock, trying rather than waiting.
 *
 * A blocking `pg_advisory_lock` is a statement, and a statement is a transaction to
 * PostgreSQL for as long as it waits. `CREATE INDEX CONCURRENTLY` waits for every
 * transaction that could see its table to finish, so the runner building an index waited
 * for the starter waiting for the runner's lock, and PostgreSQL ended one of them with
 * `deadlock detected` (D-86, amended). Each attempt here is a statement of its own that
 * returns at once, and between attempts the session is idle, which is nothing for an
 * index build to wait for.
 */
const acquireMigrationLock = async (
  conn: QueryExecutorProvider,
  waitMilliseconds: number,
): Promise<void> => {
  const deadline = performance.now() + waitMilliseconds;
  let pause = LOCK_POLL_FIRST_MILLISECONDS;
  for (;;) {
    const { rows } = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`.execute(conn);
    if (rows[0]?.locked === true) return;
    if (performance.now() + pause > deadline) {
      throw new Error(
        `another process held the migration lock for ${String(waitMilliseconds / 1000)} s; ` +
          'is a migration stuck? (pg_locks, application_name)',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pause));
    pause = Math.min(pause * 2, LOCK_POLL_MAX_MILLISECONDS);
  }
};

export interface MigrateOptions {
  /** How long to wait for another process's migration to finish. */
  readonly lockWaitMilliseconds?: number;
  /** How long a transactional migration waits for one lock; the default is ten seconds. For tests. */
  readonly lockTimeoutMilliseconds?: number;
  /** Called before a migration is run again after PostgreSQL ended it as a deadlock victim. */
  readonly onRetry?: (retry: Retry & { readonly migration: string }) => void;
  /** Attempts and waits for that; the default is `DEADLOCK_RETRY`. */
  readonly deadlockRetry?: RetryPolicy;
  /** Comment corrections to accept; the default is `COMMENT_ONLY_EDITS`. For tests. */
  readonly commentOnlyEdits?: Readonly<Record<string, CommentOnlyEdit>>;
  /** The enabled modules' sets, applied after the core's in this order. None means the core alone. */
  readonly modules?: readonly MigrationSet[];
  /** Told the names a database holds for modules this run does not carry, which are not an error. */
  readonly onDormant?: (names: readonly string[]) => void;
}

/** Idempotent: applying an already-applied migration is a no-op. */
export const migrateToLatest = async <T>(
  db: Kysely<T>,
  directory = MIGRATIONS_DIRECTORY,
  options: MigrateOptions = {},
): Promise<MigrationResultSet> => {
  const lockWaitMilliseconds = options.lockWaitMilliseconds ?? LOCK_WAIT_MILLISECONDS;
  const lockTimeoutMilliseconds = options.lockTimeoutMilliseconds ?? LOCK_TIMEOUT_MILLISECONDS;
  const results: MigrationResult[] = [];
  try {
    const sets = await loadSets(directory, options.modules ?? []);
    await db.connection().execute(async (conn) => {
      // One session for the whole run: the lock belongs to it, and ends with it if the
      // process dies. Released below on every path that gets past acquiring it.
      await acquireMigrationLock(conn, lockWaitMilliseconds);
      try {
        await sql`
          create table if not exists ${sql.table(TABLE)} (
            name varchar(255) primary key, timestamp varchar(255) not null)`.execute(conn);
        await sql`alter table ${sql.table(TABLE)} add column if not exists checksum text`.execute(
          conn,
        );

        const files = sets.flatMap((set) => set.files);
        const recorded = await readRecorded(conn);
        const { adopt, dormant } = verifySets(sets, recorded, options.commentOnlyEdits);
        if (dormant.length > 0) options.onDormant?.(dormant.map((row) => row.name));
        for (const row of adopt) {
          const file = files.find((f) => f.name === row.name);
          await sql`update ${sql.table(TABLE)} set checksum = ${file?.checksum ?? null}
            where name = ${row.name}`.execute(conn);
        }

        const done = new Set(recorded.map((row) => row.name));
        for (const file of files.filter((f) => !done.has(f.name))) {
          try {
            // A deadlock ends the migration's transaction or its waiting statement, never
            // part of one that is half-applied: a transactional file is rolled back whole,
            // and a non-transactional file is required to run again from its top (D-86), so
            // running it again is the same thing a crash and a restart would do.
            await retryOnDeadlock(
              async () => {
                await apply(conn, file, lockTimeoutMilliseconds);
              },
              options.deadlockRetry ?? DEADLOCK_RETRY,
              (retry) => options.onRetry?.({ ...retry, migration: file.name }),
            );
          } catch (error) {
            results.push({ migrationName: file.name, status: 'Error' });
            throw explainLockTimeout(file, error);
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
  commentOnlyEdits: Readonly<Record<string, CommentOnlyEdit>> = COMMENT_ONLY_EDITS,
  modules: readonly MigrationSet[] = [],
): Promise<string | undefined> => {
  const present = await sql<{ table: boolean; checksum: boolean }>`
    select to_regclass(${TABLE}) is not null as "table",
           exists (select 1 from information_schema.columns
                   where table_schema = current_schema() and table_name = ${TABLE}
                     and column_name = 'checksum') as checksum`.execute(db);
  if (present.rows[0]?.table !== true) return undefined;
  const sets = await loadSets(directory, modules);
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
    verifySets(sets, recorded, commentOnlyEdits);
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
  modules: readonly MigrationSet[] = [],
): Promise<readonly string[]> => {
  const files = (await loadSets(directory, modules)).flatMap((set) => set.files);
  const exists = await sql<{ present: boolean }>`
    select to_regclass(${TABLE}) is not null as present`.execute(db);
  if (exists.rows[0]?.present !== true) return files.map((f) => f.name);
  const { rows } = await sql<{ name: string }>`select name from ${sql.table(TABLE)}`.execute(db);
  const done = new Set(rows.map((row) => row.name));
  return files.filter((f) => !done.has(f.name)).map((f) => f.name);
};
