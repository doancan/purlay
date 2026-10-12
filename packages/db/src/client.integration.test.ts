/**
 * The two production paths into the database, run for real: the client the API
 * opens, and the migrations applied to an empty database from the first.
 *
 * Both used to run only in production or by accident — the migrator's `up` only
 * when a test template happened to be missing — so their coverage depended on the
 * machine (#202). Here they run every time.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createDatabase, DatabaseUnavailableError } from './client';
import { migrateToLatest } from './migrator';
import { integrationDatabase, closeIntegrationDatabase } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const url = (): string => process.env['DATABASE_URL'] ?? '';

const onDatabase = (name: string): string => {
  const target = new URL(url());
  target.pathname = `/${name}`;
  return target.toString();
};

describe('integration: the database client and the migrations', () => {
  test('the client the API opens connects, queries and closes', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1, ssl: false });
    try {
      const { rows } = await sql<{ answer: number }>`select 1 as answer`.execute(database);
      expect(rows).toEqual([{ answer: 1 }]);
    } finally {
      await database.destroy();
    }
  });

  test('every migration applies to an empty database, in order, and once', async () => {
    const shared = integrationDatabase();
    const name = `purlay_fresh_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await sql`create database ${sql.id(name)}`.execute(shared);
    const fresh = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: onDatabase(name), max: 1 }),
      }),
    });
    try {
      const first = await migrateToLatest(fresh);
      expect(first.error).toBeUndefined();
      const applied = (first.results ?? []).map((result) => [result.migrationName, result.status]);
      expect(applied.length).toBeGreaterThan(0);
      expect(applied.every(([, status]) => status === 'Success')).toBe(true);

      const again = await migrateToLatest(fresh);
      expect(again.results).toEqual([]);
    } finally {
      await fresh.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(shared);
    }
  });

  /**
   * Under the full suite's load this took 7–10 s and failed (#347): it waited a fixed 100 ms for the
   * two holding queries to take their connections, and connecting alone can take longer than that.
   * Now it waits until both are seen running, holds them as long as it needs, and ends them itself.
   */
  test('a pool with every connection busy fails promptly and says so, instead of waiting', async () => {
    const database = createDatabase({
      connectionString: url(),
      poolSize: 2,
      connectionTimeoutMs: 300,
    });
    // Names the holding queries in pg_stat_activity, so this test finds its own and no other's.
    const mark = `pool-busy-${crypto.randomUUID()}`;
    const holding = sql`pg_stat_activity where query like ${`%${mark}%`} and pid <> pg_backend_pid()`;
    const observer = integrationDatabase();
    try {
      const held = [1, 2].map((n) =>
        sql.raw(`select pg_sleep(60) /* ${mark} ${String(n)} */`).execute(database),
      );
      // A holding query that could not even start is the failure, said as itself.
      const startFailed = Promise.race(held).then(
        () => 'a holding query ended before it was cancelled',
        (error: unknown) => `a holding query failed: ${String(error)}`,
      );
      const failed: { reason: string | null } = { reason: null };
      void startFailed.then((reason) => {
        failed.reason = reason;
      });
      const deadline = performance.now() + 10_000;
      for (let seen = 0; seen < 2;) {
        if (failed.reason !== null) throw new Error(failed.reason);
        if (performance.now() > deadline)
          throw new Error(`only ${String(seen)} of 2 holding queries ever ran`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const row = await sql<{ count: string }>`select count(*) from ${holding}`
          .execute(observer)
          .then((result) => result.rows[0]);
        seen = Number(row?.count ?? 0);
      }

      const started = performance.now();
      const outcome = await sql`select 1`.execute(database).then(
        () => undefined,
        (error: unknown) => error,
      );
      const waited = performance.now() - started;

      expect(outcome).toBeInstanceOf(DatabaseUnavailableError);
      expect(waited).toBeLessThan(1500);
    } finally {
      // Whatever ended the test, the holds end too: otherwise closing the pool waits on them.
      await sql`select pg_cancel_backend(pid) from ${holding}`.execute(observer);
      await database.destroy();
    }
  }, 15_000); // Bounded: two connections seen busy, one refusal, two cancellations.

  /**
   * The development database does not speak TLS, so a client that insists on it —
   * with or without a CA of its own — must be refused, and the refusal must say
   * why. A client that quietly fell back to the clear would connect.
   */
  test('a client asked for TLS does not fall back to a server that has none', async () => {
    for (const sslCa of [undefined, 'not a certificate']) {
      const database = createDatabase({
        connectionString: url(),
        poolSize: 1,
        ssl: true,
        ...(sslCa === undefined ? {} : { sslCa }),
      });
      try {
        const outcome = await sql`select 1`.execute(database).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(outcome).toBeInstanceOf(DatabaseUnavailableError);
        const cause = outcome instanceof DatabaseUnavailableError ? String(outcome.cause) : '';
        expect(cause).toContain('SSL');
      } finally {
        await database.destroy();
      }
    }
  });

  test('every connection carries the timeouts and a name an operator can find it by', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      const { rows } = await sql<{ name: string; value: string }>`
        select name, setting || coalesce(unit, '') as value from pg_settings
        where name in ('statement_timeout', 'idle_in_transaction_session_timeout', 'application_name')
        order by name`.execute(database);
      expect(rows).toEqual([
        { name: 'application_name', value: 'purlay-api' },
        { name: 'idle_in_transaction_session_timeout', value: '15000ms' },
        { name: 'statement_timeout', value: '30000ms' },
      ]);
    } finally {
      await database.destroy();
    }
  });

  /**
   * An idle connection the server drops emits `error` on the pool, and an event
   * emitter with no listener for `error` throws — taking the process down for a
   * connection nothing was using. The handler is reached by terminating the
   * backend of a connection that is idle in the pool.
   */
  test('a connection the server drops while idle is reported, not fatal', async () => {
    const reported: Error[] = [];
    const database = createDatabase({
      connectionString: url(),
      poolSize: 1,
      onPoolError: (error) => reported.push(error),
    });
    try {
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(database);
      const pid = rows[0]?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);
      await sql`select pg_terminate_backend(${pid})`.execute(integrationDatabase());

      for (let waited = 0; reported.length === 0 && waited < 3000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(reported).toHaveLength(1);
      // The pool drops the dead connection and the next query opens a new one.
      expect((await sql`select 1 as one`.execute(database)).rows).toEqual([{ one: 1 }]);
    } finally {
      await database.destroy();
    }
  });
});
