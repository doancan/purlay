import { Kysely, PostgresDialect } from 'kysely';
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
