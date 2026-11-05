import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  DROP_HOOK_MS,
  integrationDatabase,
  leasingExecutor,
  sql,
  withRollback,
} from '@purlay/db';
import { AppError } from './errors';
import { withinRequest } from './logging';
import { moduleConnections, inTheCore, type ModuleBudget } from './module-budget';
import { atomicallyOn } from './transactions';

// A pool ends when its last leased connection has been given back, which is as late as the slowest request still
// holding one: the time drops wait for, not the five seconds of a hook that waits on nothing (`DROP_HOOK_MS`).
afterAll(async () => {
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const BUDGET: ModuleBudget = { maxConcurrent: 1, queueTimeoutMs: 30, statementTimeoutMs: 200 };
const MANIFESTS = [
  { id: 'notes', budget: { poolShare: (): ModuleBudget => BUDGET } },
  { id: 'alone', budget: { none: 'a module nothing is kept from' } },
] as const;

/** The application's database as a module's request sees it: leased by the share of the module the request is noted as. */
const database = (): ReturnType<typeof integrationDatabase> =>
  leasingExecutor(integrationDatabase(), moduleConnections(MANIFESTS, 10));

const asRequest = async <T>(module: string | undefined, body: () => Promise<T>): Promise<T> =>
  await withinRequest(
    { requestId: crypto.randomUUID(), startedAt: 0, ...(module === undefined ? {} : { module }) },
    body,
  );

/** What the call threw, or `undefined` when it did not. */
const thrown = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
};

const timeoutSeen = async (db: ReturnType<typeof integrationDatabase>): Promise<string> =>
  (await sql<{ value: string }>`select current_setting('statement_timeout') as value`.execute(db))
    .rows[0]?.value ?? '';

describe('integration: a module held to its share of the database', () => {
  test('runs a read as much as a write under its own time limit, which the next holder of the connection does not find', async () => {
    const db = database();
    expect(await asRequest('notes', async () => await timeoutSeen(db))).toBe('200ms');
    expect(
      await asRequest(
        'notes',
        async () => await atomicallyOn(db)(async (trx) => await timeoutSeen(trx)),
      ),
    ).toBe('200ms');
    expect(await timeoutSeen(integrationDatabase())).not.toBe('200ms');
    expect(await timeoutSeen(db)).not.toBe('200ms');
  });

  test("ends a statement that runs past it with the database's own cancellation, and frees the slot for the next", async () => {
    const db = database();
    const error = await thrown(
      async () => await asRequest('notes', async () => await sql`select pg_sleep(2)`.execute(db)),
    );
    expect(error).toMatchObject({ code: '57014' });
    expect(await asRequest('notes', async () => await timeoutSeen(db))).toBe('200ms');
  });

  test('refuses a request over the cap as the database being busy, after waiting its turn, and counts a transaction once', async () => {
    const db = database();
    let release: () => void = () => undefined;
    let isInside: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      isInside = resolve;
    });
    const held = asRequest('notes', async () => {
      await atomicallyOn(db)(async (trx) => {
        // Reads inside the transaction, on the pool: the request is one holder, and does not wait for itself.
        await sql`select 1`.execute(db);
        await sql`select 1`.execute(trx);
        // A holder that takes longer to be inside than a request waits for a slot: a loaded runner's connection.
        await sql`select pg_sleep(0.1)`.execute(trx);
        await new Promise<void>((resolve) => {
          release = resolve;
          isInside();
        });
      });
    });
    // Not a pause that guesses how long a connection takes: on a loaded runner a holder that was not inside yet was
    // never released, and its transaction kept the pool from closing. If it fails to get inside, its failure is said.
    await Promise.race([inside, held]);
    try {
      const refused = await thrown(
        async () => await asRequest('notes', async () => await sql`select 1`.execute(db)),
      );
      expect(refused).toBeInstanceOf(AppError);
      expect((refused as AppError).body.code).toBe('DATABASE_UNAVAILABLE');
      // The core, and the work the core does inside a module's request, are not held by it.
      await asRequest(undefined, async () => await sql`select 1`.execute(db));
      await asRequest(
        'notes',
        async () => await inTheCore(async () => await sql`select 1`.execute(db))(),
      );
    } finally {
      release();
      await held;
    }
    await asRequest('notes', async () => await sql`select 1`.execute(db));
  });

  test('frees the slot when the body throws', async () => {
    const db = database();
    const error = await thrown(
      async () =>
        await asRequest(
          'notes',
          async () => await atomicallyOn(db)(() => Promise.reject(new Error('the body failed'))),
        ),
    );
    expect(String(error)).toContain('the body failed');
    await asRequest('notes', async () => await sql`select 1`.execute(db));
  });

  test('is not asked for a transaction the caller already holds', async () => {
    await withRollback(async (transaction) => {
      const held = leasingExecutor(transaction, moduleConnections(MANIFESTS, 10));
      expect(held).toBe(transaction);
      await asRequest('notes', async () => await sql`select 1`.execute(held));
    });
  });
});
