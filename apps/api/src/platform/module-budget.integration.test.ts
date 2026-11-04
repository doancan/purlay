import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, integrationDatabase, sql, withRollback } from '@purlay/db';
import { AppError } from './errors';
import { budgeted, type ModuleBudget } from './module-budget';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const BUDGET: ModuleBudget = { maxConcurrent: 1, queueTimeoutMs: 30, statementTimeoutMs: 200 };

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
  test('runs its statements under its own time limit, which does not outlive the transaction', async () => {
    const db = integrationDatabase();
    const atomically = budgeted('notes', BUDGET, db);
    const inside = await atomically(async (transaction) => await timeoutSeen(transaction));
    expect(inside).toBe('200ms');
    expect(await timeoutSeen(db)).not.toBe('200ms');
  });

  test('ends a statement that runs past it as the database being busy, which a client retries, and frees the slot for the next', async () => {
    const db = integrationDatabase();
    const atomically = budgeted('notes', BUDGET, db);
    const error = await thrown(() =>
      atomically(async (transaction) => {
        await sql`select pg_sleep(2)`.execute(transaction);
      }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).body.code).toBe('DATABASE_UNAVAILABLE');
    expect(await atomically(() => Promise.resolve('next'))).toBe('next');
  });

  test('refuses a request over the cap as the database being busy, after waiting its turn', async () => {
    const db = integrationDatabase();
    const atomically = budgeted('notes', BUDGET, db);
    let release: () => void = () => undefined;
    const held = atomically(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Bun.sleep(10);
    try {
      const refused = await thrown(() => atomically(() => Promise.resolve('never')));
      expect(refused).toBeInstanceOf(AppError);
      expect((refused as AppError).body.code).toBe('DATABASE_UNAVAILABLE');
    } finally {
      // Whatever was asserted, the held transaction ends, or the run cannot.
      release();
      await held;
    }
    expect(await atomically(() => Promise.resolve('again'))).toBe('again');
  });

  test('frees the slot when the body throws', async () => {
    const db = integrationDatabase();
    const atomically = budgeted('notes', BUDGET, db);
    const error = await thrown(() =>
      atomically(() => Promise.reject(new Error('the body failed'))),
    );
    expect(String(error)).toContain('the body failed');
    expect(await atomically(() => Promise.resolve('free'))).toBe('free');
  });

  test('joins a transaction the caller already holds, and takes no slot', async () => {
    await withRollback(async (transaction) => {
      const atomically = budgeted('notes', BUDGET, transaction);
      const result = await atomically(async (inner) => {
        expect(inner).toBe(transaction);
        return await atomically(() => Promise.resolve('inner'));
      });
      expect(result).toBe('inner');
    });
  });
});
