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
import { migrateToLatest, pendingMigrations } from './migrator';
import { closeIntegrationDatabase, integrationDatabase } from './testing';

const onDatabase = (name: string): string => {
  const target = new URL(process.env['DATABASE_URL'] ?? '');
  target.pathname = `/${name}`;
  return target.toString();
};

const open = (name: string, max = 1): Kysely<unknown> =>
  new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: onDatabase(name), max }),
    }),
  });

const directories: string[] = [];
const databases: string[] = [];

/** A directory of migrations, written from a name → SQL map. */
const migrationsDirectory = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-migrations-'));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return directory;
};

const freshDatabase = async (): Promise<string> => {
  const name = `purlay_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await sql`create database ${sql.id(name)}`.execute(integrationDatabase());
  databases.push(name);
  return name;
};

beforeAll(() => {
  integrationDatabase();
});

afterAll(async () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  const admin = integrationDatabase();
  for (const name of databases)
    await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
  await closeIntegrationDatabase();
});

describe('integration: a migration that leaves its transaction', () => {
  test('can create an index concurrently, which a transactional migration cannot', async () => {
    const name = await freshDatabase();
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
      const other = open(await freshDatabase());
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
    const db = open(await freshDatabase());
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
    const db = open(await freshDatabase());
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
   * The scan is made slow on purpose (a few milliseconds a row), so the window is
   * long enough to observe. The transactional run is measured too: a probe that
   * never saw a blocked reader there would prove nothing about its absence below.
   */
  const SLOW_VALIDATION = `
    CREATE TABLE rows (id int, note text);
    INSERT INTO rows SELECT g, 'x' FROM generate_series(1, 400) g;
    CREATE FUNCTION slow_ok(v text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS
      $$ BEGIN PERFORM pg_sleep(0.005); RETURN v IS NOT NULL; END $$;
  `;
  const CONSTRAINT = `
    ALTER TABLE rows ADD CONSTRAINT rows_note_ok CHECK (slow_ok(note)) NOT VALID;
    ALTER TABLE rows VALIDATE CONSTRAINT rows_note_ok;
  `;

  const blockedReads = async (name: string, constraint: string): Promise<number> => {
    const migrating = open(name);
    const reader = open(name);
    const directory = migrationsDirectory({
      '0001_rows.sql': SLOW_VALIDATION,
      '0002_constraint.sql': constraint,
    });
    try {
      // The table exists before the run under test, as a populated table would.
      await migrateToLatest(migrating, migrationsDirectory({ '0001_rows.sql': SLOW_VALIDATION }));
      const state = { finished: false };
      const run = migrateToLatest(migrating, directory).then((result) => {
        state.finished = true;
        return result;
      });
      let blocked = 0;
      let reads = 0;
      while (!state.finished) {
        try {
          await sql`set lock_timeout = '150ms'`.execute(reader);
          await sql`select id from rows limit 1`.execute(reader);
          reads += 1;
        } catch {
          blocked += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const { error } = await run;
      expect(error).toBeUndefined();
      expect(reads + blocked).toBeGreaterThan(5);
      return blocked;
    } finally {
      await migrating.destroy();
      await reader.destroy();
    }
  };

  test('validating a constraint inside the transaction blocks readers; outside it, it does not', async () => {
    expect(await blockedReads(await freshDatabase(), CONSTRAINT)).toBeGreaterThan(0);
    expect(
      await blockedReads(await freshDatabase(), `-- purlay: no-transaction\n${CONSTRAINT}`),
    ).toBe(0);
  });
});

describe('integration: checksums', () => {
  const v1 = { '0001_t.sql': 'CREATE TABLE t (id int);' };

  test('an edited migration is a failure before anything runs', async () => {
    const db = open(await freshDatabase());
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
    const db = open(await freshDatabase());
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
    const db = open(await freshDatabase());
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
    const db = open(await freshDatabase());
    try {
      await migrateToLatest(db, migrationsDirectory(v1));
      const { error } = await migrateToLatest(db, migrationsDirectory({}));
      expect(String(error)).toContain('previously applied migration 0001_t is missing');
    } finally {
      await db.destroy();
    }
  });

  test('a new migration that sorts before an applied one is refused', async () => {
    const db = open(await freshDatabase());
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
    const name = await freshDatabase();
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
    const name = await freshDatabase();
    const holder = open(name);
    const waiter = open(name);
    const directory = migrationsDirectory({ '0001_a.sql': 'CREATE TABLE a (id int);' });
    try {
      await holder.connection().execute(async (conn) => {
        await sql`select pg_advisory_lock(1886351481)`.execute(conn);
        const started = performance.now();
        const { error, results } = await migrateToLatest(waiter, directory, 300);
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
    const name = await freshDatabase();
    const db = open(name);
    try {
      const failing = migrationsDirectory({ '0001_bad.sql': 'SELECT 1/0;' });
      expect(String((await migrateToLatest(db, failing)).error)).toContain('division by zero');
      // A second starter, on another session, must get the lock at once.
      const other = open(name);
      try {
        const started = performance.now();
        const fixed = migrationsDirectory({ '0001_bad.sql': 'CREATE TABLE ok (id int);' });
        const outcome = await migrateToLatest(other, fixed, 1000);
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
    const name = await freshDatabase();
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
