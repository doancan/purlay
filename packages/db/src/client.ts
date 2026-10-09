import { readFileSync } from 'node:fs';
import {
  Kysely,
  PostgresDialect,
  Transaction as KyselyTransaction,
  type PostgresPool,
} from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

/**
 * The Kysely client.
 *
 * `pg` with Kysely's own dialect rather than Bun's built-in SQL: there is no
 * Kysely dialect for it, so using it would mean owning a driver adapter on the
 * hottest path in the system, with no test suite behind it. A driver defect
 * there is a data-correctness defect. (`CONTRIBUTING.md` §1.12)
 *
 * **It fails fast and says what is wrong (D-87).** A pool with every connection
 * busy used to make the next query wait for one to free, for as long as it took —
 * 7.7 s measured with a pool of two. Now the wait is bounded, and running out is
 * a `DatabaseUnavailableError` the API turns into a 503. Every connection also
 * carries a statement timeout, an idle-in-transaction timeout and a name, so a
 * runaway query or a forgotten transaction ends by itself and `pg_stat_activity`
 * says whose it is. The numbers are in `docs/CONFIG.md`.
 */
export interface DatabaseOptions {
  readonly connectionString: string;
  /** `DATABASE_POOL_MAX` — see `docs/CONFIG.md`. */
  readonly poolSize?: number;
  readonly ssl?: boolean;
  /** PEM text of the certificate authority to trust instead of the system's, for a private or managed root. */
  readonly sslCa?: string;
  /** How long a query waits for a free connection before giving up. */
  readonly connectionTimeoutMs?: number;
  /** Server-side limit on one statement; `0` disables it, for the migrator. */
  readonly statementTimeoutMs?: number;
  /** Called when the pool reports a failed idle connection. Without a listener Node would exit. */
  readonly onPoolError?: (error: Error) => void;
}

/** The numbers `docs/CONFIG.md` publishes. */
export const POOL_DEFAULTS = {
  connectionTimeoutMs: 3_000,
  statementTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 15_000,
  idleConnectionMs: 30_000,
  applicationName: 'purlay-api',
} as const;

/** No connection could be had: the pool is exhausted, or the server is not answering. */
export class DatabaseUnavailableError extends Error {
  constructor(cause: unknown) {
    super('no database connection was available', { cause });
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * The TLS settings as the process environment spells them — what the CLI reads,
 * and what the API's configuration loader (`config.ts`) must agree with, which a
 * test in the API binds. A value neither spelling recognises is refused: a
 * migration run in the clear because of a typo is the quiet failure.
 */
export const tlsFromEnvironment = (
  environment: Record<string, string | undefined>,
): { readonly ssl: boolean; readonly sslCa?: string } => {
  const raw = environment['DATABASE_SSL'];
  let ssl: boolean;
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') ssl = false;
  else if (raw === 'true' || raw === '1') ssl = true;
  else throw new Error(`DATABASE_SSL must be true or false, not "${raw}". See docs/CONFIG.md.`);

  const caFile = environment['DATABASE_SSL_CA_FILE'];
  if (caFile === undefined || caFile === '') return { ssl };
  if (!ssl) throw new Error('DATABASE_SSL_CA_FILE needs DATABASE_SSL=true. See docs/CONFIG.md.');
  return { ssl, sslCa: readCaFile(caFile) };
};

/** Reads the CA a deployment mounted. A path that cannot be read is a boot failure, not a fallback. */
export const readCaFile = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`DATABASE_SSL_CA_FILE cannot be read: ${path}`, { cause });
  }
};

/** Every failure to obtain a connection is the same fact to a caller: there was none. */
const unavailableWhenEmpty = (pool: pg.Pool): PostgresPool => ({
  options: pool.options,
  connect: async (): Promise<pg.PoolClient> => {
    try {
      return await pool.connect();
    } catch (error) {
      throw new DatabaseUnavailableError(error);
    }
  },
  end: async (): Promise<void> => {
    await pool.end();
  },
});

export const createDatabase = (options: DatabaseOptions): Kysely<DB> => {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? POOL_DEFAULTS.connectionTimeoutMs,
    idleTimeoutMillis: POOL_DEFAULTS.idleConnectionMs,
    statement_timeout: options.statementTimeoutMs ?? POOL_DEFAULTS.statementTimeoutMs,
    idle_in_transaction_session_timeout: POOL_DEFAULTS.idleInTransactionTimeoutMs,
    application_name: POOL_DEFAULTS.applicationName,
    ...(options.ssl === true
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(options.sslCa === undefined ? {} : { ca: options.sslCa }),
          },
        }
      : {}),
  });
  pool.on('error', (error) => options.onPoolError?.(error));
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: unavailableWhenEmpty(pool) }) });
};

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
