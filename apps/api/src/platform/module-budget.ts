/**
 * What one module may take from the shared database (`MODULES.md` §7, D-250 rule 7).
 *
 * Modules share a process, an event loop and one pool, so a module whose queries are slow would hold every
 * connection and chat's sends would queue behind it. The share is a cap on the transactions a module has open
 * at once and a time limit on each statement in them; a request over the cap waits a short while for a slot
 * and then is told the database is busy, which a client retries (`503 DATABASE_UNAVAILABLE`); so is a request one
 * of whose statements ran past the time limit.
 *
 * It wraps the transaction boundary and nothing else: a service takes `Atomically` as before (D-46), so it
 * cannot tell whether it was budgeted, and a caller already inside a transaction — a test's — joins it.
 */
import { isTransaction, sql, type Executor } from '@purlay/db';
import { AppError } from './errors';
import type { Atomically } from './transactions';

export interface ModuleBudget {
  /** Transactions the module may have open at once; at least one, and below the pool's size. */
  readonly maxConcurrent: number;
  /** How long a request waits for a slot before it is refused. */
  readonly queueTimeoutMs: number;
  /** The longest any statement of the module may run; PostgreSQL ends it with `57014`. */
  readonly statementTimeoutMs: number;
}

export interface Slots {
  /** True with a slot, false when none came free within `timeoutMs`. */
  acquire(timeoutMs: number): Promise<boolean>;
  release(): void;
  inUse(): number;
}

/** First in, first out, with a limit on the wait. A slot given up is handed to the next in line at once. */
export const slots = (limit: number): Slots => {
  let inUse = 0;
  const waiting: ((granted: boolean) => void)[] = [];
  return {
    inUse: (): number => inUse,
    acquire: (timeoutMs: number): Promise<boolean> => {
      if (inUse < limit) {
        inUse += 1;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const turn = (granted: boolean): void => {
          clearTimeout(timer);
          resolve(granted);
        };
        const timer = setTimeout(() => {
          const at = waiting.indexOf(turn);
          if (at !== -1) waiting.splice(at, 1);
          resolve(false);
        }, timeoutMs);
        waiting.push(turn);
      });
    },
    release: (): void => {
      const next = waiting.shift();
      // The slot passes to the one waiting; it is not freed and taken again.
      if (next === undefined) inUse -= 1;
      else next(true);
    },
  };
};

/** PostgreSQL's `query_canceled`, which is what ends a statement that ran past `statement_timeout`. */
const QUERY_CANCELED = '57014';

const isStatementTimeout = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === QUERY_CANCELED;

/** The transaction boundary of one module, held to its budget. */
export const budgeted = (module: string, budget: ModuleBudget, executor: Executor): Atomically => {
  const share = slots(budget.maxConcurrent);
  const busy = (message: string): AppError =>
    new AppError({ code: 'DATABASE_UNAVAILABLE', message });
  return async (body) => {
    if (isTransaction(executor)) return await body(executor);
    if (!(await share.acquire(budget.queueTimeoutMs)))
      throw busy(`The ${module} module's share of the database is in use. Try again.`);
    try {
      return await executor.transaction().execute(async (transaction) => {
        // Local to this transaction, so the connection goes back to the pool as it was found.
        await sql`select set_config('statement_timeout', ${String(budget.statementTimeoutMs)}, true)`.execute(
          transaction,
        );
        return await body(transaction);
      });
    } catch (error) {
      // A statement over its limit is the same answer as a share in use: the module is busy, and a client retries.
      if (isStatementTimeout(error)) {
        throw busy(`The ${module} module's request ran past its time limit. Try again.`);
      }
      throw error;
    } finally {
      share.release();
    }
  };
};
