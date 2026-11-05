import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, integrationDatabase, sql, withRollback } from '@purlay/db';
import { AppError } from './errors';
import { budgeted, transactionsOfModules, type ModuleBudget } from './module-budget';

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

describe('integration: the boundary of each module of a build', () => {
  const manifests = [
    { id: 'shared', budget: { poolShare: (): ModuleBudget => BUDGET } },
    { id: 'alone', budget: { none: 'a module nothing is kept from' } },
  ] as const;

  /** How many of `calls` at once the boundary lets in: the rest are refused as the database being busy. */
  const admitted = async (
    atomically: ReturnType<ReturnType<typeof transactionsOfModules>>,
    calls: number,
  ): Promise<number> => {
    const release: (() => void)[] = [];
    const held = Array.from({ length: calls }, () =>
      atomically(
        () =>
          new Promise<void>((resolve) => {
            release.push(resolve);
          }),
      ).then(
        () => 'done',
        () => 'refused',
      ),
    );
    await Bun.sleep(80);
    const inside = release.length;
    for (const resolve of release) resolve();
    await Promise.all(held);
    return inside;
  };

  test('is the share a module declares, and the plain boundary for one that declared none', async () => {
    const boundary = transactionsOfModules(manifests, integrationDatabase(), 10);
    expect(await admitted(boundary('shared'), 3)).toBe(1);
    expect(await admitted(boundary('alone'), 3)).toBe(3);
  });

  test('is made once per module, so one share counts every request', () => {
    const boundary = transactionsOfModules(manifests, integrationDatabase(), 10);
    expect(boundary('shared')).toBe(boundary('shared'));
  });

  test('is worked out from the pool the process has', async () => {
    const sized = [
      {
        id: 'shared',
        budget: { poolShare: (pool: number): ModuleBudget => ({ ...BUDGET, maxConcurrent: pool }) },
      },
    ];
    const boundary = transactionsOfModules(sized, integrationDatabase(), 2);
    expect(await admitted(boundary('shared'), 3)).toBe(2);
  });

  test('refuses a module the build does not carry, as a bug of the caller', () => {
    const boundary = transactionsOfModules(manifests, integrationDatabase(), 10);
    expect(() => boundary('notes')).toThrow('no module "notes" is carried by this build');
  });
});
