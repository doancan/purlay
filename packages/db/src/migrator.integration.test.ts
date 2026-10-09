/**
 * The migration runner, run against real tables (D-86).
 *
 * Every test builds a directory of synthetic migrations and an empty database of
 * its own, so none of them depends on the real migrations or on another test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  codeChecksum,
  COMMENT_ONLY_EDITS,
  migrateToLatest,
  migrationHistoryProblem,
  pendingMigrations,
  readMigrationFiles,
} from './migrator';
import { closeIntegrationDatabase, integrationDatabase } from './testing';

/**
 * A pool whose connections see one schema and nothing else.
 *
 * Each test migrates a schema of its own in the shared database rather than a
 * database of its own. A database costs the server seven megabytes of copying and a
 * checkpoint to drop, and a file that made thirteen of them spent more than a
 * hook's five seconds in `afterAll` on a slow disk (the runner's: "a beforeEach/
 * afterEach hook timed out"). A schema costs a catalogue row. What the tests
 * check — the migrations table, the lock, the DDL — is the same in either; the
 * advisory lock is per database, and the tests run one after another.
 */
const open = (schema: string, max = 1, settings = ''): Kysely<unknown> =>
  new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: process.env['DATABASE_URL'] ?? '',
        options: `-c search_path=${schema} ${settings}`.trim(),
        max,
      }),
    }),
  });

const directories: string[] = [];
const schemas: string[] = [];

/** A directory of migrations, written from a name → SQL map. */
const migrationsDirectory = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-migrations-'));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return directory;
};

const freshSchema = async (): Promise<string> => {
  const name = `mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await sql`create schema ${sql.id(name)}`.execute(integrationDatabase());
  schemas.push(name);
  return name;
};

beforeAll(() => {
  integrationDatabase();
});

afterAll(async () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  for (const name of schemas)
    await sql`drop schema ${sql.id(name)} cascade`.execute(integrationDatabase());
  await closeIntegrationDatabase();
});

describe('integration: a migration that leaves its transaction', () => {
  test('can create an index concurrently, which a transactional migration cannot', async () => {
    const name = await freshSchema();
    const db = open(name);
    try {
      const directory = migrationsDirectory({
        '0001_t.sql': 'CREATE TABLE t (id int);',
        '0002_index.sql':
          '-- purlay: no-transaction\n-- why: concurrent\nDROP INDEX CONCURRENTLY IF EXISTS t_id;\nCREATE INDEX CONCURRENTLY t_id ON t (id);',
      });
      const { error, results } = await migrateToLatest(db, directory);
      expect(error).toBeUndefined();
      expect(results?.map((r) => [r.migrationName, r.status])).toEqual([
        ['0001_t', 'Success'],
        ['0002_index', 'Success'],
      ]);
      const index = await sql<{ indisvalid: boolean }>`
        select indisvalid from pg_index where indexrelid = 't_id'::regclass`.execute(db);
      expect(index.rows).toEqual([{ indisvalid: true }]);

      // The same statement without the opt-out is refused by PostgreSQL itself —
      // which is what makes the first half of this test mean something.
      const refused = migrationsDirectory({
        '0001_t.sql': 'CREATE TABLE u (id int);',
        '0002_index.sql': 'CREATE INDEX CONCURRENTLY u_id ON u (id);',
      });
      const other = open(await freshSchema());
      try {
        const attempt = await migrateToLatest(other, refused);
        expect(String(attempt.error)).toContain('cannot run inside a transaction block');
      } finally {
        await other.destroy();
      }
    } finally {
      await db.destroy();
    }
  });

  test('a transactional migration leaves nothing behind when it fails', async () => {
    const db = open(await freshSchema());
    try {
      const directory = migrationsDirectory({
        '0001_bad.sql': 'CREATE TABLE half (id int);\nSELECT 1/0;',
      });
      const { error, results } = await migrateToLatest(db, directory);
      expect(String(error)).toContain('division by zero');
      expect(results).toEqual([{ migrationName: '0001_bad', status: 'Error' }]);
      expect((await sql`select to_regclass('half') as t`.execute(db)).rows).toEqual([{ t: null }]);
      expect(await pendingMigrations(db, directory)).toEqual(['0001_bad']);
    } finally {
      await db.destroy();
    }
  });

  test('a non-transactional migration that fails is not recorded, so the next start runs it again', async () => {
    const db = open(await freshSchema());
    try {
      const directory = migrationsDirectory({
        '0001_partial.sql':
          '-- purlay: no-transaction\nCREATE TABLE IF NOT EXISTS partial (id int);\nSELECT 1/0;',
      });
      const { error } = await migrateToLatest(db, directory);
      expect(String(error)).toContain('division by zero');
      expect((await sql`select to_regclass('partial') as t`.execute(db)).rows).toEqual([
        { t: 'partial' },
      ]);
      expect(await pendingMigrations(db, directory)).toEqual(['0001_partial']);
    } finally {
      await db.destroy();
    }
  });

  /**
   * The reason the opt-out exists. A constraint added NOT VALID takes an
   * ACCESS EXCLUSIVE lock for an instant; VALIDATE then takes one that lets
   * readers and writers through — but only if the first lock was released. Inside
   * one transaction it is held to the end, and every SELECT waits out the scan.
   *
   * The scan is held open by the test, not made slow: the constraint's function
   * waits for an advisory lock the test holds, so the validation is in progress
   * exactly as long as the test says and the reader is probed while it is. An
   * earlier version made the scan slow with a sleep per row and counted the reads
   * that were blocked in a window of two seconds; under load the window moved, the
   * sample count with it, and the test ran past its five seconds (18 of 30 runs
   * with fourteen busy processes beside it). The transactional run is probed too:
   * a probe that never saw a blocked reader there would prove nothing about its
   * absence below.
   */
  const HELD_KEY = 424_242;
  const VALIDATION_HELD = `
    CREATE TABLE rows (id int, note text);
    INSERT INTO rows VALUES (1, 'x');
    CREATE FUNCTION held_ok(v text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS
      $$ BEGIN
        PERFORM pg_advisory_lock(${String(HELD_KEY)});
        PERFORM pg_advisory_unlock(${String(HELD_KEY)});
        RETURN v IS NOT NULL;
      END $$;
  `;
  const CONSTRAINT = `
    ALTER TABLE rows ADD CONSTRAINT rows_note_ok CHECK (held_ok(note)) NOT VALID;
    ALTER TABLE rows VALIDATE CONSTRAINT rows_note_ok;
  `;

  /** Whether a reader is refused while the validation of `constraint` is in progress. */
  const readerIsBlocked = async (name: string, constraint: string): Promise<boolean> => {
    const migrating = open(name);
    const reader = open(name);
    const holder = open(name);
    const directory = migrationsDirectory({
      '0001_rows.sql': VALIDATION_HELD,
      '0002_constraint.sql': constraint,
    });
    try {
      // The table exists before the run under test, as a populated table would.
      await migrateToLatest(migrating, migrationsDirectory({ '0001_rows.sql': VALIDATION_HELD }));
      await sql`select pg_advisory_lock(${HELD_KEY})`.execute(holder);
      const run = migrateToLatest(migrating, directory);
      // The validation has started when a backend of this database waits for the lock.
      const deadline = Date.now() + 4_000;
      for (;;) {
        const { rows } = await sql<{ waiting: string }>`
          select count(*) as waiting from pg_locks
          where locktype = 'advisory' and not granted and objid = ${HELD_KEY}`.execute(holder);
        if (Number(rows[0]?.waiting) > 0) break;
        if (Date.now() > deadline) throw new Error('the validation never started');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      let blocked = false;
      try {
        await sql`set lock_timeout = '200ms'`.execute(reader);
        await sql`select id from rows limit 1`.execute(reader);
      } catch {
        blocked = true;
      }

      await sql`select pg_advisory_unlock(${HELD_KEY})`.execute(holder);
      expect((await run).error).toBeUndefined();
      return blocked;
    } finally {
      await migrating.destroy();
      await reader.destroy();
      await holder.destroy();
    }
  };

  test('validating a constraint inside the transaction blocks readers; outside it, it does not', async () => {
    expect(await readerIsBlocked(await freshSchema(), CONSTRAINT)).toBe(true);
    expect(
      await readerIsBlocked(await freshSchema(), `-- purlay: no-transaction\n${CONSTRAINT}`),
    ).toBe(false);
  });
});

describe('integration: checksums', () => {
  const v1 = { '0001_t.sql': 'CREATE TABLE t (id int);' };

  test('an edited migration is a failure before anything runs', async () => {
    const db = open(await freshSchema());
    try {
      expect((await migrateToLatest(db, migrationsDirectory(v1))).error).toBeUndefined();

      const edited = migrationsDirectory({
        '0001_t.sql': 'CREATE TABLE t (id int, extra int);',
        '0002_next.sql': 'CREATE TABLE next (id int);',
      });
      const { error, results } = await migrateToLatest(db, edited);
      expect(String(error)).toContain('0001_t was edited after it was applied');
      expect(results).toEqual([]);
      expect((await sql`select to_regclass('next') as t`.execute(db)).rows).toEqual([{ t: null }]);
    } finally {
      await db.destroy();
    }
  });

  test('a comment-only edit is still an edit — the file is the unit', async () => {
    const db = open(await freshSchema());
    try {
      await migrateToLatest(db, migrationsDirectory(v1));
      const { error } = await migrateToLatest(
        db,
        migrationsDirectory({ '0001_t.sql': '-- a comment\nCREATE TABLE t (id int);' }),
      );
      expect(String(error)).toContain('was edited after it was applied');
    } finally {
      await db.destroy();
    }
  });

  test('a database migrated before checksums existed adopts them once, then detects an edit', async () => {
    const db = open(await freshSchema());
    try {
      // What the previous runner left behind: the table, rows, and no checksum column.
      await sql`create table kysely_migration (name varchar(255) primary key, timestamp varchar(255) not null)`.execute(
        db,
      );
      await sql`create table t (id int)`.execute(db);
      await sql`insert into kysely_migration values ('0001_t', '2026-01-01T00:00:00.000Z')`.execute(
        db,
      );

      const adopted = await migrateToLatest(db, migrationsDirectory(v1));
      expect(adopted).toEqual({ results: [] });
      const row = await sql<{ checksum: string | null }>`
        select checksum from kysely_migration`.execute(db);
      expect(row.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);

      const edited = await migrateToLatest(
        db,
        migrationsDirectory({ '0001_t.sql': 'CREATE TABLE t (id int, extra int);' }),
      );
      expect(String(edited.error)).toContain('was edited after it was applied');
    } finally {
      await db.destroy();
    }
  });

  test('an applied migration whose file has gone is refused', async () => {
    const db = open(await freshSchema());
    try {
      await migrateToLatest(db, migrationsDirectory(v1));
      const { error } = await migrateToLatest(db, migrationsDirectory({}));
      expect(String(error)).toContain('previously applied migration 0001_t is missing');
    } finally {
      await db.destroy();
    }
  });

  test('a new migration that sorts before an applied one is refused', async () => {
    const db = open(await freshSchema());
    try {
      await migrateToLatest(db, migrationsDirectory({ '0002_t.sql': 'CREATE TABLE t (id int);' }));
      const { error } = await migrateToLatest(
        db,
        migrationsDirectory({
          '0001_early.sql': 'CREATE TABLE early (id int);',
          '0002_t.sql': 'CREATE TABLE t (id int);',
        }),
      );
      expect(String(error)).toContain('must sort after the last applied one');
    } finally {
      await db.destroy();
    }
  });
});

describe('integration: concurrent starters', () => {
  /**
   * A starter that waits for the lock must not be a transaction while it waits. A
   * blocking `pg_advisory_lock` is one statement, and a statement is a transaction to
   * PostgreSQL; `CREATE INDEX CONCURRENTLY` waits for every transaction that could see the
   * table to finish. The runner then waits for the waiter, the waiter for the runner's
   * lock, and PostgreSQL ends one of them with `deadlock detected` (D-86).
   *
   * The earlier test of three starters had no concurrent index build, so it could not see
   * this. Here the first migration to run builds one after a pause long enough for the
   * second starter to be waiting for the lock by then.
   */
  test('a starter waiting for the lock does not deadlock an index built concurrently', async () => {
    const name = await freshSchema();
    const directory = migrationsDirectory({
      '0001_table.sql':
        'CREATE TABLE t (n int);\nINSERT INTO t SELECT g FROM generate_series(1, 1000) g;',
      '0002_index.sql':
        '-- purlay: no-transaction\nSELECT pg_sleep(0.5);\n' +
        'DROP INDEX CONCURRENTLY IF EXISTS t_n;\nCREATE INDEX CONCURRENTLY t_n ON t (n);',
    });
    const pools = [open(name), open(name)];
    try {
      const outcomes = await Promise.all(pools.map((pool) => migrateToLatest(pool, directory)));
      expect(outcomes.map((o) => (o.error instanceof Error ? o.error.message : 'none'))).toEqual([
        'none',
        'none',
      ]);
      const applied = outcomes.flatMap((o) => (o.results ?? []).map((r) => r.migrationName));
      expect(applied.toSorted()).toEqual(['0001_table', '0002_index']);
    } finally {
      for (const pool of pools) await pool.destroy();
    }
  });

  test('a starter that cannot get the lock in time says so, and does not touch the database', async () => {
    const name = await freshSchema();
    const holder = open(name);
    const waiter = open(name);
    const directory = migrationsDirectory({ '0001_a.sql': 'CREATE TABLE a (id int);' });
    try {
      await holder.connection().execute(async (conn) => {
        await sql`select pg_advisory_lock(1886351481)`.execute(conn);
        const started = performance.now();
        const { error, results } = await migrateToLatest(waiter, directory, {
          lockWaitMilliseconds: 300,
        });
        expect(String(error)).toContain('held the migration lock');
        expect(performance.now() - started).toBeLessThan(2000);
        expect(results).toEqual([]);
        await sql`select pg_advisory_unlock(1886351481)`.execute(conn);
      });
      expect((await sql`select to_regclass('a') as t`.execute(waiter)).rows).toEqual([{ t: null }]);
    } finally {
      await holder.destroy();
      await waiter.destroy();
    }
  });

  test('the lock is released when a migration fails, so the next starter is not kept waiting', async () => {
    const name = await freshSchema();
    const db = open(name);
    try {
      const failing = migrationsDirectory({ '0001_bad.sql': 'SELECT 1/0;' });
      expect(String((await migrateToLatest(db, failing)).error)).toContain('division by zero');
      // A second starter, on another session, must get the lock at once.
      const other = open(name);
      try {
        const started = performance.now();
        const fixed = migrationsDirectory({ '0001_bad.sql': 'CREATE TABLE ok (id int);' });
        const outcome = await migrateToLatest(other, fixed, { lockWaitMilliseconds: 1000 });
        expect(outcome.error).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(1000);
      } finally {
        await other.destroy();
      }
    } finally {
      await db.destroy();
    }
  });

  test('three processes starting together apply every migration exactly once', async () => {
    const name = await freshSchema();
    const directory = migrationsDirectory({
      '0001_a.sql': 'CREATE TABLE a (id int);',
      '0002_slow.sql':
        '-- purlay: no-transaction\nSELECT pg_sleep(0.5);\nCREATE TABLE IF NOT EXISTS b (id int);',
      '0003_c.sql': 'CREATE TABLE c (id int);',
    });
    const pools = [open(name), open(name), open(name)];
    try {
      const outcomes = await Promise.all(pools.map((pool) => migrateToLatest(pool, directory)));
      expect(outcomes.map((o) => o.error)).toEqual([undefined, undefined, undefined]);
      const applied = outcomes.flatMap((o) => (o.results ?? []).map((r) => r.migrationName));
      expect(applied.toSorted()).toEqual(['0001_a', '0002_slow', '0003_c']);
    } finally {
      for (const pool of pools) await pool.destroy();
    }
  });
});

describe('integration: a migration that is the victim of a deadlock', () => {
  /**
   * Migration 0010 took the exclusive lock of an `ALTER TABLE` on `messages` while a send,
   * which locks `messages` and then `channels`, took the same two in the other order; at
   * thousands of writes a second PostgreSQL ended the migrator with `deadlock detected`.
   * The crossed locks are made here by hand and the order is fixed, so the migrator is the
   * victim every time: a test session holds `b`, the migration takes `a` and waits for `b`,
   * and only then does the test session ask for `a`. The migrator's `deadlock_timeout` is
   * the shorter, so it is the one that runs the check and is ended.
   *
   * Both kinds of migration are tried: a transactional one is rolled back whole by the
   * deadlock, a non-transactional one loses only the statement that was waiting.
   */
  const FILES = {
    'transactional (rolled back whole)':
      'LOCK TABLE a IN ACCESS EXCLUSIVE MODE;\nLOCK TABLE b IN ACCESS EXCLUSIVE MODE;\nCREATE TABLE done (n int);',
    'non-transactional (the file runs again from its top)':
      '-- purlay: no-transaction\nALTER TABLE a DROP CONSTRAINT IF EXISTS a_b_fkey;\n' +
      'ALTER TABLE a ADD CONSTRAINT a_b_fkey FOREIGN KEY (b_id) REFERENCES b (id);',
  } as const;

  const waiters = async (): Promise<number> => {
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from pg_locks where locktype = 'relation' and not granted`.execute(
      integrationDatabase(),
    );
    return Number(rows[0]?.n);
  };

  for (const [kind, migration] of Object.entries(FILES)) {
    test(`${kind}: the migrator retries and succeeds, saying so`, async () => {
      const schema = await freshSchema();
      const setup = open(schema);
      const migrating = open(schema, 1, '-c deadlock_timeout=500ms');
      const session = open(schema);
      const base = {
        '0001_tables.sql': 'CREATE TABLE b (id int PRIMARY KEY);\nCREATE TABLE a (b_id int);',
      };
      try {
        expect((await migrateToLatest(setup, migrationsDirectory(base))).error).toBeUndefined();
        const directory = migrationsDirectory({ ...base, '0002_crossed.sql': migration });

        const retried: string[] = [];
        let outcome: Awaited<ReturnType<typeof migrateToLatest>> | undefined;
        await session.connection().execute(async (conn) => {
          await sql`begin`.execute(conn);
          await sql`lock table b in access exclusive mode`.execute(conn);
          const running = migrateToLatest(migrating, directory, {
            onRetry: (retry) => retried.push(`${retry.migration} #${String(retry.attempt)}`),
          });
          // Wait for the positive condition: the migration is waiting for `b`.
          for (let waited = 0; (await waiters()) === 0 && waited < 5000; waited += 10) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(await waiters()).toBeGreaterThan(0);
          // Closes the cycle. Held until the migrator has been ended, then released.
          await sql`lock table a in access exclusive mode`.execute(conn);
          await sql`commit`.execute(conn);
          outcome = await running;
        });

        expect(outcome?.error).toBeUndefined();
        expect(retried).toEqual(['0002_crossed #1']);
        expect(outcome?.results).toEqual([{ migrationName: '0002_crossed', status: 'Success' }]);
      } finally {
        await setup.destroy();
        await migrating.destroy();
        await session.destroy();
      }
    }, 30_000);
  }
});

describe('integration: a corrected comment in an applied migration', () => {
  const checksumOf = (text: string): string =>
    new Bun.CryptoHasher('sha256').update(text).digest('hex');
  const ORIGINAL = '-- says one thing\nCREATE TABLE t (id int);';
  const CORRECTED = '-- says another, and at more length\nCREATE  TABLE t\n  (id int);';

  const afterApplying = async (body: (db: Kysely<unknown>) => Promise<void>): Promise<void> => {
    const schema = await freshSchema();
    const db = open(schema);
    try {
      expect(
        (await migrateToLatest(db, migrationsDirectory({ '0001_t.sql': ORIGINAL }))).error,
      ).toBeUndefined();
      await body(db);
    } finally {
      await db.destroy();
    }
  };

  const listed = {
    '0001_t': { previous: checksumOf(ORIGINAL), code: codeChecksum(ORIGINAL) },
  };
  const checksumRecorded = async (db: Kysely<unknown>): Promise<string | null | undefined> =>
    (await sql<{ checksum: string | null }>`select checksum from kysely_migration`.execute(db))
      .rows[0]?.checksum;

  test('is accepted when the entry names the recorded checksum and the code is unchanged, and is recorded', async () => {
    await afterApplying(async (db) => {
      const directory = migrationsDirectory({ '0001_t.sql': CORRECTED });
      const { error } = await migrateToLatest(db, directory, { commentOnlyEdits: listed });
      expect(error).toBeUndefined();
      expect(await checksumRecorded(db)).toBe(checksumOf(CORRECTED));
      // From then on it is an ordinary applied file, and the entry is no longer needed.
      const again = await migrateToLatest(db, directory, { commentOnlyEdits: {} });
      expect(again.error).toBeUndefined();
      expect(await migrationHistoryProblem(db, directory, {})).toBeUndefined();
    });
  });

  test('is accepted by readiness before the migrator has recorded it', async () => {
    await afterApplying(async (db) => {
      const directory = migrationsDirectory({ '0001_t.sql': CORRECTED });
      expect(await migrationHistoryProblem(db, directory, listed)).toBeUndefined();
      expect(await migrationHistoryProblem(db, directory, {})).toContain('was edited');
    });
  });

  test('is refused when the edit changed a statement, however the entry reads', async () => {
    await afterApplying(async (db) => {
      const changed = migrationsDirectory({
        '0001_t.sql': '-- says another\nCREATE TABLE t (id int, extra int);',
      });
      const { error } = await migrateToLatest(db, changed, { commentOnlyEdits: listed });
      expect(String(error)).toContain('was edited after it was applied');
      expect(await checksumRecorded(db)).toBe(checksumOf(ORIGINAL));
    });
  });

  test('is refused when the database recorded some other checksum than the one listed', async () => {
    await afterApplying(async (db) => {
      await sql`update kysely_migration set checksum = repeat('0', 64)`.execute(db);
      const directory = migrationsDirectory({ '0001_t.sql': CORRECTED });
      const { error } = await migrateToLatest(db, directory, { commentOnlyEdits: listed });
      expect(String(error)).toContain('was edited after it was applied');
    });
  });

  /**
   * The table is code, and so is checked like code: each entry must still describe the
   * file it names. An edit to a statement of 0010 would fail here before it failed anywhere
   * a database had applied it.
   */
  test('every entry of the real table describes a real file whose code has not changed', async () => {
    const files = await readMigrationFiles();
    for (const [name, edit] of Object.entries(COMMENT_ONLY_EDITS)) {
      const file = files.find((candidate) => candidate.name === name);
      expect(file).toBeDefined();
      expect(codeChecksum(file?.text ?? '')).toBe(edit.code);
      expect(file?.checksum).not.toBe(edit.previous);
    }
  });
});
