import { Kysely, PostgresDialect, Transaction as KyselyTransaction } from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

/**
 * The Kysely client.
 *
 * `pg` with Kysely's own dialect rather than Bun's built-in SQL: there is no
 * Kysely dialect for it, so using it would mean owning a driver adapter on the
 * hottest path in the system, with no test suite behind it. A driver defect
 * there is a data-correctness defect. (`CONTRIBUTING.md` §1.12)
 */
export interface DatabaseOptions {
  readonly connectionString: string;
  /** `DATABASE_POOL_MAX` — see `docs/CONFIG.md`. */
  readonly poolSize?: number;
  readonly ssl?: boolean;
}

/**
 * `DATABASE_SSL` as the process environment spells it — the one reader the CLI
 * and the API's configuration loader (`config.ts`) must agree on, and a test in
 * the API binds the two. A value neither spelling recognises is refused: a
 * migration run in the clear because of a typo is the quiet failure.
 */
export const sslFromEnvironment = (environment: Record<string, string | undefined>): boolean => {
  const raw = environment['DATABASE_SSL'];
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(`DATABASE_SSL must be true or false, not "${raw}". See docs/CONFIG.md.`);
};

export const createDatabase = (options: DatabaseOptions): Kysely<DB> =>
  new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: options.connectionString,
        max: options.poolSize ?? 10,
        ...(options.ssl === true ? { ssl: { rejectUnauthorized: true } } : {}),
      }),
    }),
  });

/**
 * Services and repositories take their executor as an argument — a `Kysely` or a
 * `Transaction`, indistinguishable to the caller. That is what makes
 * one-transaction-per-test possible, and it is why no module reaches for a
 * database handle of its own. (D-46)
 */
export type Executor = Kysely<DB>;

/**
 * An executor that is *known* to be inside a transaction. A service that writes
 * twice takes this rather than `Executor`, so passing it the pool — the mistake
 * that leaves half a workspace behind — does not compile. `Executor` accepts a
 * transaction; this does not accept the pool, because the two differ in the
 * literal type of `isTransaction`.
 */
export type Transaction = KyselyTransaction<DB>;

/** Narrows an executor to a transaction, by what it is rather than by a flag. */
export const isTransaction = (executor: Executor): executor is Transaction =>
  executor instanceof KyselyTransaction;
