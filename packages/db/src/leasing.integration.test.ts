/**
 * An executor that asks a lease for each connection it takes (`leasingExecutor`), on a real pool: what the lease is
 * given back and when, what a refusal looks like to the caller, and that a connection a lease set a limit on is not
 * found so by the next holder.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  createDatabase,
  executorOnPool,
  isTransaction,
  leasingExecutor,
  type ConnectionLease,
  type LeaseConnection,
} from './client';
import type { DB } from './schema';
import { closeIntegrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const url = (): string => process.env['DATABASE_URL'] ?? '';

/** A lease that counts what happens to it. */
const counting = (
  statementTimeoutMs?: number,
): { lease: LeaseConnection; taken: number; released: number } => {
  const record = { taken: 0, released: 0 };
  return Object.assign(record, {
    lease: (): Promise<ConnectionLease> => {
      record.taken += 1;
      return Promise.resolve({
        ...(statementTimeoutMs === undefined ? {} : { statementTimeoutMs }),
        release: (): void => {
          record.released += 1;
        },
      });
    },
  });
};

const limitSeen = async (database: ReturnType<typeof createDatabase>): Promise<string> =>
  (
    await sql<{ value: string }>`select current_setting('statement_timeout') as value`.execute(
      database,
    )
  ).rows[0]?.value ?? '';

/** What the call threw, or `undefined` when it did not. */
const thrown = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('integration: an executor that leases its connections', () => {
  test('asks for one lease a statement, and one for a whole transaction, and gives each back', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 2 });
    try {
      const leases = counting();
      const leasing = leasingExecutor(database, leases.lease);
      await sql`select 1`.execute(leasing);
      await sql`select 1`.execute(leasing);
      expect([leases.taken, leases.released]).toEqual([2, 2]);
      await leasing.transaction().execute(async (transaction) => {
        await sql`select 1`.execute(transaction);
        await sql`select 2`.execute(transaction);
        expect([leases.taken, leases.released]).toEqual([3, 2]);
      });
      expect([leases.taken, leases.released]).toEqual([3, 3]);
    } finally {
      await database.destroy();
    }
  });

  test('gives the lease back when the statement fails', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      const leases = counting();
      const leasing = leasingExecutor(database, leases.lease);
      expect(await thrown(async () => await sql`select 1 / 0`.execute(leasing))).toBeInstanceOf(
        Error,
      );
      expect(leases.released).toBe(1);
      // The pool of one is free again.
      await sql`select 1`.execute(leasing);
    } finally {
      await database.destroy();
    }
  });

  test('lets a refusal reach the caller as it is, and takes no connection for it', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      const refusal = new Error('the share is in use');
      const leasing = leasingExecutor(database, () => Promise.reject(refusal));
      expect(await thrown(async () => await sql`select 1`.execute(leasing))).toBe(refusal);
      await sql`select 1`.execute(database);
    } finally {
      await database.destroy();
    }
  });

  test("gives the connection the limit the lease asks for, and the next holder the pool's own", async () => {
    const database = createDatabase({
      connectionString: url(),
      poolSize: 1,
      statementTimeoutMs: 20_000,
    });
    try {
      const leasing = leasingExecutor(database, counting(750).lease);
      expect(await limitSeen(leasing)).toBe('750ms');
      // The same connection, since the pool has one: not left at what the lease set.
      expect(await limitSeen(database)).toBe('20s');
      expect(await limitSeen(leasing)).toBe('750ms');
    } finally {
      await database.destroy();
    }
  });

  test('an undefined lease takes the connection as the pool gives it', async () => {
    const database = createDatabase({
      connectionString: url(),
      poolSize: 1,
      statementTimeoutMs: 20_000,
    });
    try {
      const leasing = leasingExecutor(database, () => Promise.resolve(undefined));
      expect(await limitSeen(leasing)).toBe('20s');
    } finally {
      await database.destroy();
    }
  });

  test('refuses a lease whose signal has aborted before it takes a connection, with the reason it aborted for', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      const reason = new Error('past its deadline');
      let released = 0;
      const leasing = leasingExecutor(database, () =>
        Promise.resolve({
          signal: AbortSignal.abort(reason),
          release: (): void => {
            released += 1;
          },
        }),
      );
      expect(await thrown(async () => await sql`select 1`.execute(leasing))).toBe(reason);
      expect(released).toBe(1);
      await sql`select 1`.execute(database);
    } finally {
      await database.destroy();
    }
  });

  test('cancels the statement a connection is running when the signal aborts, and leaves the connection usable', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      const controller = new AbortController();
      const leasing = leasingExecutor(database, () =>
        Promise.resolve({ signal: controller.signal, release: (): void => undefined }),
      );
      const started = performance.now();
      const running = thrown(async () => await sql`select pg_sleep(20)`.execute(leasing));
      await Bun.sleep(100);
      controller.abort(new Error('past its deadline'));
      expect(await running).toMatchObject({ code: '57014' });
      expect(performance.now() - started).toBeLessThan(5_000);
      await sql`select 1`.execute(database);
    } finally {
      await database.destroy();
    }
  });

  test('does not cancel what runs on the connection after the lease was given back', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      const controller = new AbortController();
      const leasing = leasingExecutor(database, () =>
        Promise.resolve({ signal: controller.signal, release: (): void => undefined }),
      );
      await sql`select 1`.execute(leasing);
      const later = sql`select pg_sleep(0.3), 1 as ok`.execute(database);
      controller.abort(new Error('past its deadline'));
      expect((await later).rows).toHaveLength(1);
    } finally {
      await database.destroy();
    }
  });

  test('says so, and leaves the statement to its own limit, when the cancellation cannot be made', async () => {
    const pool = new pg.Pool({ connectionString: url(), max: 1 });
    const reported: Error[] = [];
    const database = executorOnPool(pool, 0, (error) => reported.push(error));
    try {
      const controller = new AbortController();
      const leasing = leasingExecutor(database, () =>
        Promise.resolve({ signal: controller.signal, release: (): void => undefined }),
      );
      const running = thrown(async () => await sql`select pg_sleep(0.6)`.execute(leasing));
      await Bun.sleep(100);
      // Where the control connection would go, nothing answers: the statement is the pool's to end.
      pool.options.connectionString = 'postgres://nobody@127.0.0.1:1/none';
      controller.abort(new Error('past its deadline'));
      expect(await running).toBeUndefined();
      const until = performance.now() + 5_000;
      while (reported.length === 0 && performance.now() < until) await Bun.sleep(20);
      expect(reported.length).toBeGreaterThan(0);
    } finally {
      await database.destroy();
    }
  });

  test('refuses a lease whose statement limit the server cannot take, gives everything back and leaves the pool usable', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      let released = 0;
      const leasing = leasingExecutor(database, () =>
        Promise.resolve({
          statementTimeoutMs: Number.NaN,
          release: (): void => {
            released += 1;
          },
        }),
      );
      expect(await thrown(async () => await sql`select 1`.execute(leasing))).toBeInstanceOf(Error);
      expect(released).toBe(1);
      await sql`select 1`.execute(database);
    } finally {
      await database.destroy();
    }
  });

  test('keeps the plugins a test put on the executor it was made from', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1 });
    try {
      let seen = 0;
      const plugged = database.withPlugin({
        transformQuery: (args) => {
          seen += 1;
          return args.node;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      const leases = counting();
      await sql`select 1`.execute(leasingExecutor(plugged, leases.lease));
      expect([seen, leases.taken]).toEqual([1, 1]);
    } finally {
      await database.destroy();
    }
  });

  test('is a transaction already held, as it was given', async () => {
    await withRollback(async (transaction) => {
      const leases = counting();
      const leasing = leasingExecutor(transaction, leases.lease);
      expect(leasing).toBe(transaction);
      expect(isTransaction(leasing)).toBe(true);
      await sql`select 1`.execute(leasing);
      expect(leases.taken).toBe(0);
    });
  });

  test('refuses an executor that was not made on a pool of this package, rather than leave it unleased', async () => {
    const bare = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url(), max: 1 }) }),
    });
    try {
      expect(() => leasingExecutor(bare, () => Promise.resolve(undefined))).toThrow(
        'cannot be leased',
      );
    } finally {
      await bare.destroy();
    }
  });
});
